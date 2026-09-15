#!/usr/bin/env python3
"""Install only this application's operational timers after a healthy deployment."""
import os,pathlib,subprocess,json,urllib.request
os.umask(0o077)
root=pathlib.Path('/opt/via/zoho-mcp')
assert pathlib.Path(__file__).resolve().parent==root/'ops', 'Run from the deployed Zoho application'
with urllib.request.urlopen('https://books-mcp.via-int.com/health',timeout=10) as response:
    health=json.load(response)
assert health.get('status')=='ok' and health.get('version')==json.loads((root/'package.json').read_text())['version']
names=['zoho-mcp-monitor','zoho-mcp-backup','zoho-mcp-restore-test']
for name in names:
    for suffix in ['service','timer']:
        unit=name+'.'+suffix
        source=root/'ops'/unit
        target=pathlib.Path('/etc/systemd/system')/unit
        assert source.is_file() and not target.is_symlink()
        target.write_bytes(source.read_bytes());target.chmod(0o644)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now',*[name+'.timer' for name in names]],check=True)
print(json.dumps({'status':'installed','timers':names,'other_services_restarted':False}))
