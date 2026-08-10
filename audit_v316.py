from __future__ import annotations
import json, re, subprocess, sys
from pathlib import Path
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parent

class IdParser(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids=[]; self.scripts=[]; self.styles=[]
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if 'id' in a: self.ids.append(a['id'])
        if tag=='script' and a.get('src'): self.scripts.append(a['src'])
        if tag=='link' and a.get('href') and 'stylesheet' in a.get('rel',''): self.styles.append(a['href'])

def js_syntax(report):
    fails=[]
    for f in sorted((ROOT/'js').glob('*.js')):
        r=subprocess.run(['node','--check',str(f)],capture_output=True,text=True)
        if r.returncode: fails.append({'file':f.name,'error':r.stderr.strip()})
    report['js_syntax']={'ok':not fails,'failures':fails,'count':len(list((ROOT/'js').glob('*.js')))}

def html_checks(report):
    p=IdParser(); p.feed((ROOT/'index.html').read_text(encoding='utf-8'))
    counts={i:p.ids.count(i) for i in set(p.ids)}; dups={k:v for k,v in counts.items() if v>1}
    missing=[]
    for src in p.scripts:
        if src.startswith(('http://','https://')): continue
        path=src.split('?',1)[0]
        if not (ROOT/path).exists(): missing.append(path)
    for href in p.styles:
        if href.startswith(('http://','https://')): continue
        path=href.split('?',1)[0]
        if not (ROOT/path).exists(): missing.append(path)
    report['html']={'id_count':len(p.ids),'duplicate_ids':dups,'missing_assets':sorted(set(missing)),'ok':not dups and not missing}

def dom_refs(report):
    html=(ROOT/'index.html').read_text(encoding='utf-8')
    p=IdParser(); p.feed(html); ids=set(p.ids)
    refs=set()
    patterns=[r'\$\(["\']([^"\']+)["\']\)',r'getElementById\(["\']([^"\']+)["\']\)']
    for f in (ROOT/'js').glob('*.js'):
        t=f.read_text(encoding='utf-8')
        for pat in patterns: refs.update(re.findall(pat,t))
    missing=sorted(x for x in refs if x not in ids)
    # Some IDs belong to reset-password.html; filter known alternate-page ids.
    alt=''
    rp=ROOT/'reset-password.html'
    if rp.exists(): alt=rp.read_text(encoding='utf-8')
    missing=[x for x in missing if f'id="{x}"' not in alt and f"id='{x}'" not in alt]
    report['dom_refs']={'static_ref_count':len(refs),'missing_in_index_or_reset':missing,'ok':not missing}

def css_check(report):
    t=(ROOT/'assets/styles.css').read_text(encoding='utf-8')
    report['css']={'open_braces':t.count('{'),'close_braces':t.count('}'),'ok':t.count('{')==t.count('}')}

def rpc_check(report):
    used=set(); defined=set()
    for f in (ROOT/'js').glob('*.js'):
        t=f.read_text(encoding='utf-8')
        used.update(re.findall(r'\.rpc\(["\']([^"\']+)',t))
        # dynamic cascades / arrays with known RPC naming
        used.update(re.findall(r'["\']((?:list|get|admin|sync|mark|send|respond|remove|edit|revoke|set|begin|finish|cancel|submit|ensure|system)_[a-zA-Z0-9_]+)["\']',t))
        used.discard('admin_ready')
    for f in (ROOT/'supabase').glob('*.sql'):
        t=f.read_text(encoding='utf-8')
        defined.update(re.findall(r'create\s+(?:or\s+replace\s+)?function\s+public\.([a-zA-Z0-9_]+)',t,re.I))
    current_used={u for u in used if not u.endswith(('_v310','_v311','_v312','_v313','_v3131','_v314'))}
    missing=sorted(u for u in current_used if u not in defined and u not in {'admin-users','create-payos-payment','payos-webhook'})
    report['rpc']={'used_count':len(used),'defined_count':len(defined),'missing_current':missing,'ok':not missing}

def sql_check(report):
    issues=[]
    for f in sorted((ROOT/'supabase').glob('*.sql')):
        t=f.read_text(encoding='utf-8')
        if t.count('$$')%2: issues.append(f'{f.name}: unbalanced $$')
    repair=ROOT/'supabase/017_v3_16_full_system_repair.sql'
    if not repair.exists(): issues.append('missing 017 repair migration')
    else:
        t=repair.read_text(encoding='utf-8')
        if t.lower().count('begin;')<1 or t.lower().count('commit;')<1: issues.append('017 transaction wrapper missing')
        for required in ['system_health_v316','ensure_my_account_v316','admin_dashboard_v316','list_member_directory_v316','set_my_avatar_thumb_v315']:
            if required not in t: issues.append(f'017 missing {required}')
        if 'between 100 and 220' in t: issues.append('017 contains obsolete 100..220 profile zoom constraint')
    report['sql_static']={'issues':issues,'ok':not issues}

def versions(report):
    index=(ROOT/'index.html').read_text(encoding='utf-8')
    refs=sorted(set(re.findall(r'\?v=([0-9.]+)',index)))
    label=re.search(r'WEB V([0-9.]+)',index)
    report['versioning']={'cache_versions':refs,'ui_version':label.group(1) if label else None,'ok':refs==['3.16.1'] and bool(label and label.group(1)=='3.16.1')}

def core_files(report):
    required=['js/app.js','js/export-worker.js','js/auth.js','js/membership.js','js/profile.js','js/community.js','js/admin.js','js/avatar-service.js','js/system-health.js','assets/styles.css','index.html']
    miss=[x for x in required if not (ROOT/x).exists()]
    report['core_files']={'missing':miss,'ok':not miss}

def main():
    report={}
    for fn in [js_syntax,html_checks,dom_refs,css_check,rpc_check,sql_check,versions,core_files]:
        try: fn(report)
        except Exception as e: report[fn.__name__]={'ok':False,'exception':repr(e)}
    report['overall_ok']=all(v.get('ok',False) for k,v in report.items() if isinstance(v,dict) and 'ok' in v)
    out=ROOT/'TEST_REPORT_V3_16.json'; out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report['overall_ok'] else 1
if __name__=='__main__': raise SystemExit(main())
