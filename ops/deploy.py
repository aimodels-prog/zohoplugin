import os,pathlib,subprocess,json,time,urllib.request,shutil,tarfile,sys,re,fcntl,datetime
os.umask(0o077)
commit=sys.argv[1] if len(sys.argv)>1 else ''; assert re.fullmatch(r'[a-f0-9]{40}',commit),'Supply an exact Git commit SHA'
root=pathlib.Path('/opt/via/zoho-mcp')
stage=pathlib.Path('/opt/via/zoho-mcp-releases')/commit
backup=pathlib.Path('/opt/via/zoho-mcp-backups')/(datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+commit[:7])
stage.mkdir(parents=True,exist_ok=True); backup.mkdir(parents=True,exist_ok=True)
lock=(stage.parent/'deploy.lock').open('w'); fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
resultpath=stage/'deployment-result.json'
if resultpath.exists() and json.loads(resultpath.read_text()).get('status')=='deployed':
 with urllib.request.urlopen('https://books-mcp.via-int.com/health',timeout=5) as response:
  if json.load(response).get('build_id')==commit:print(resultpath.read_text());raise SystemExit(0)
def run(a,**kw):return subprocess.run(a,check=True,**kw)
def out(a):return subprocess.check_output(a,text=True).strip()
def sql(s):return out(['docker','exec','zoho-mcp-postgres','psql','-U','zoho','-d','zoho_books','-Atc',s])
def health():
 with urllib.request.urlopen('https://books-mcp.via-int.com/health',timeout=5) as r:return json.load(r)
assert root.is_dir() and (root/'.env').is_file()
app=json.loads(out(['docker','inspect','zoho-mcp-app']))[0]
assert app['Config']['Labels']['com.docker.compose.project']=='zoho-books-mcp'
assert app['Config']['Labels']['com.docker.compose.project.working_dir']==str(root)
oldenv=dict(v.split('=',1) for v in app['Config']['Env'])
assert oldenv['PUBLIC_URL']=='https://books-mcp.via-int.com'
assert oldenv.get('TOKEN_ENCRYPTION_KEY'),'Existing encryption key missing'
oldimage=app['Image']
run(['docker','tag',oldimage,'zoho-books-mcp-app:pre-'+commit[:7]])
archive=stage/'release.tar.gz'
urllib.request.urlretrieve('https://codeload.github.com/aimodels-prog/zohoplugin/tar.gz/'+commit,archive)
with tarfile.open(archive) as t:t.extractall(stage,filter='data')
src=stage/('zohoplugin-'+commit)
version=json.loads((src/'package.json').read_text())['version']
shutil.copy2(root/'.env',src/'.env')
text=(src/'.env').read_text()
text='\n'.join(line for line in text.splitlines() if not line.startswith('BUILD_ID='))+'\nBUILD_ID='+commit+'\n'
(src/'.env').write_text(text); (src/'.env').chmod(0o600)
compose=['docker','compose','--project-directory',str(src)]
run(compose+['config','--quiet'])
cfg=json.loads(out(compose+['config','--format','json']))
for key in ['DATABASE_URL','TOKEN_ENCRYPTION_KEY','PUBLIC_URL','ZOHO_CLIENT_ID','ZOHO_CLIENT_SECRET','ZOHO_READ_ONLY','ALLOWED_EMAIL_DOMAINS']:
 assert str(cfg['services']['app']['environment'][key])==oldenv[key], 'Preserved setting mismatch: '+key
run(compose+['build','app'])
expected_tools=int(out(['docker','run','--rm','-e','ZOHO_READ_ONLY='+oldenv['ZOHO_READ_ONLY'],'zoho-books-mcp-app:latest','node','--input-type=module','-e',"import tools from './tools.js';console.log(tools.length);process.exit(0)"]))
print('Build complete; backing up application',flush=True)
with tarfile.open(backup/'source.tar.gz','w:gz') as t:t.add(root,arcname='zoho-mcp')
with (backup/'database.dump').open('wb') as f:run(['docker','exec','zoho-mcp-postgres','pg_dump','-U','zoho','-d','zoho_books','-Fc'],stdout=f)
with (backup/'database.dump').open('rb') as f:run(['docker','exec','-i','zoho-mcp-postgres','pg_restore','--list'],stdin=f,stdout=subprocess.DEVNULL)
ids=out(['docker','ps','-q']).split()
containers=json.loads(out(['docker','inspect',*ids]))
baseline={x['Name']:(x['Id'],x['State']['StartedAt'],x['RestartCount']) for x in containers if x['Name']!='/zoho-mcp-app'}
(backup/'containers-before.json').write_text(json.dumps(baseline))
users=set(sql('SELECT id FROM users').splitlines())
refresh_before=int(sql("SELECT count(*) FROM oauth_tokens WHERE kind='refresh' AND expires_at>now()"))
livecompose=['docker','compose','--project-directory',str(root)]
replaced=False
try:
 shutil.copytree(src,root,dirs_exist_ok=True); (root/'.env').chmod(0o600)
 run(livecompose+['config','--quiet'])
 replaced=True
 run(livecompose+['up','-d','--no-deps','--no-build','--force-recreate','app'])
 ok=False
 for i in range(25):
  try:
   h=health()
   if h.get('status')=='ok' and h.get('build_id')==commit and h.get('version')==version and h.get('tools')==expected_tools:ok=True;break
  except Exception:pass
  time.sleep(2)
 assert ok,'Deployment health verification failed'
 assert h['readOnly']==(oldenv['ZOHO_READ_ONLY'].lower()!='false')
 assert users.issubset(set(sql('SELECT id FROM users').splitlines())),'An existing linked account disappeared'
 after=json.loads(out(['docker','inspect',*list(baseline)]))
 changed=[x['Name'] for x in after if baseline[x['Name']]!=(x['Id'],x['State']['StartedAt'],x['RestartCount'])]
 result={'status':'deployed','health':h,'existing_linked_accounts_preserved':len(users),'refresh_credentials_before':refresh_before,
 'refresh_credentials_after':int(sql("SELECT count(*) FROM oauth_tokens WHERE kind='refresh' AND expires_at>now()")),
 'other_containers_checked':len(baseline),'other_containers_changed':changed,'backup':str(backup)}
 resultpath.write_text(json.dumps(result));print(json.dumps(result),flush=True)
except Exception as e:
 print('Deployment failed:',str(e),flush=True)
 with tarfile.open(backup/'source.tar.gz') as t:t.extractall('/opt/via',filter='data')
 run(['docker','tag',oldimage,'zoho-books-mcp-app:latest'])
 if replaced:run(livecompose+['up','-d','--no-deps','--no-build','--force-recreate','app'])
 resultpath.write_text(json.dumps({'status':'rolled_back','reason':str(e)}));raise
