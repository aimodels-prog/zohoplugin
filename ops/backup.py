#!/usr/bin/env python3
"""Zoho-only backup and optional isolated restore drill. Never edits another app."""
import os,sys,pathlib,subprocess,json,datetime,secrets,time,hashlib,shutil
os.umask(0o077)
base=pathlib.Path('/opt/via/zoho-mcp-backups').resolve()
target=(base/('scheduled-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+secrets.token_hex(3))).resolve()
assert target.is_relative_to(base) and target!=base
target.mkdir(parents=True)
database_size=int(subprocess.check_output(['docker','exec','zoho-mcp-postgres','psql','-U','zoho','-d','zoho_books','-Atc',"SELECT pg_database_size(current_database())"]))
assert shutil.disk_usage(base).free > 2*database_size+5*1024**3, 'Insufficient free disk space for backup; review retention before retrying'
dump=target/'database.dump'
def run(args,**kwargs):return subprocess.run(args,check=True,**kwargs)
with dump.open('wb') as output:run(['docker','exec','zoho-mcp-postgres','pg_dump','-U','zoho','-d','zoho_books','-Fc'],stdout=output)
with dump.open('rb') as source:run(['docker','exec','-i','zoho-mcp-postgres','pg_restore','--list'],stdin=source,stdout=subprocess.DEVNULL)
app=json.loads(subprocess.check_output(['docker','inspect','zoho-mcp-app']))[0]
env=dict(v.split('=',1) for v in app['Config']['Env'])
assert env.get('TOKEN_ENCRYPTION_KEY'),'No encryption key to back up'
(target/'encryption-key').write_text(env['TOKEN_ENCRYPTION_KEY'])
manifest={'database':'zoho_books','sha256':hashlib.sha256(dump.read_bytes()).hexdigest(),'build_id':env.get('BUILD_ID'),'restore_test':'not_run'}
if '--verify-restore' in sys.argv:
    name='zoho-backup-restore-'+secrets.token_hex(5)
    try:
        run(['docker','run','-d','--name',name,'--network','none','--label','purpose=zoho-backup-restore','-e','POSTGRES_PASSWORD='+secrets.token_hex(24),'postgres:16-alpine'],stdout=subprocess.DEVNULL)
        for _ in range(30):
            if subprocess.run(['docker','exec',name,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
            time.sleep(1)
        with dump.open('rb') as source:run(['docker','exec','-i',name,'pg_restore','-U','postgres','-d','postgres','--no-owner','--no-acl','--exit-on-error'],stdin=source)
        encrypted=json.loads(subprocess.check_output(['docker','exec',name,'psql','-U','postgres','-d','postgres','-Atc',"SELECT COALESCE(json_agg(zoho_refresh_token),'[]'::json) FROM users"]))
        code="import {decrypt} from './security.js';const values="+json.dumps(encrypted)+";for(const v of values)decrypt(v);console.log(JSON.stringify({credentials_decryptable:values.length}));"
        run(['docker','exec','-i','-w','/app','zoho-mcp-app','node','--input-type=module'],input=code.encode())
        manifest['restore_test']='passed_in_isolated_container'
    finally:
        subprocess.run(['docker','rm','-f','-v',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
(target/'manifest.json').write_text(json.dumps(manifest))
print(json.dumps({'backup_directory':str(target),**manifest}))
