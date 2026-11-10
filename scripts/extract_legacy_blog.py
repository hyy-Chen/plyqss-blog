#!/usr/bin/env python3
import argparse, html, json, re, shutil
from html.parser import HTMLParser
from pathlib import Path

class Node:
    def __init__(self, tag=None, attrs=None, parent=None, text=''):
        self.tag, self.attrs, self.parent, self.children, self.text = tag, dict(attrs or []), parent, [], text

class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True); self.root=Node('root'); self.cur=self.root
    def handle_starttag(self, tag, attrs):
        n=Node(tag,attrs,self.cur); self.cur.children.append(n)
        if tag not in {'img','br','hr','meta','input','link'}: self.cur=n
    def handle_startendtag(self, tag, attrs): self.handle_starttag(tag,attrs)
    def handle_endtag(self, tag):
        n=self.cur
        while n is not self.root:
            if n.tag == tag: self.cur=n.parent; return
            n=n.parent
    def handle_data(self, data): self.cur.children.append(Node(parent=self.cur,text=data))

def text(n): return ''.join(text(c) if c.tag else c.text for c in n.children)
def esc(s): return s.replace('\\','\\\\').replace('\n',' ')
def inline(n):
    if not n.tag: return n.text
    t=n.tag
    if t in {'script','style','button','svg'}: return ''
    if t=='br': return '\n'
    if t=='img':
        src=n.attrs.get('src',''); alt=n.attrs.get('alt','')
        return f'![{alt}]({src})' if src else ''
    s=''.join(inline(c) for c in n.children)
    if t in {'strong','b'}: return '**'+s.strip()+'**'
    if t in {'em','i'}: return '*'+s.strip()+'*'
    if t=='a':
        if n.attrs.get('class') == 'headerlink' or n.attrs.get('href','').startswith('#'): return ''
        return f'[{s.strip()}]({n.attrs.get("href","")})' if n.attrs.get('href') else s
    if t=='code' and n.parent and n.parent.tag!='pre': return '`'+s.strip()+'`'
    return s

def render(n, level=0):
    if not n.tag: return n.text
    t=n.tag
    if t in {'script','style','button','svg','nav','header','footer'}: return ''
    if t=='pre':
        code=next((c for c in n.children if c.tag=='code'), None)
        raw=text(code or n)
        lang=''
        if code:
            m=re.search(r'language-([\w+-]+)', code.attrs.get('class',''))
            lang=m.group(1) if m else code.attrs.get('data-language','')
        return '\n```'+lang+'\n'+html.unescape(raw).strip('\n')+'\n```\n'
    if t in {'h1','h2','h3','h4','h5','h6'}:
        return '\n'+'#'*int(t[1])+ ' '+inline(n).strip()+'\n'
    if t=='p': return '\n'+inline(n).strip()+'\n'
    if t=='li': return '\n- '+inline(n).strip()
    if t in {'ul','ol'}: return '\n'+''.join(render(c,level+1) for c in n.children)+'\n'
    if t=='blockquote': return '\n'+ '\n'.join('> '+x for x in inline(n).strip().splitlines())+'\n'
    if t=='hr': return '\n---\n'
    if t=='img': return '\n'+inline(n)+'\n'
    return ''.join(render(c,level) for c in n.children)

def find_article(root):
    stack=[root]
    while stack:
        n=stack.pop()
        if n.tag and n.attrs.get('id')=='articleContent': return n
        stack.extend(reversed(n.children))

def convert(src, title, date, alias, tags, out, private=False):
    p=Parser(); p.feed(Path(src).read_text(encoding='utf-8',errors='replace')); article=find_article(p.root)
    if not article: raise RuntimeError('articleContent not found: '+src)
    body=render(article)
    body=re.sub(r'\n{3,}','\n\n',body).strip()+'\n'
    fm=['---',f'title: {title}',f'date: {date}', 'tags:'] + [f'  - {x}' for x in tags]
    if alias: fm.append('aliases:'); fm.append(f'  - {alias}')
    if private: fm += ['stealth: true','password: __INJECTED__']
    fm += ['---','']
    Path(out).parent.mkdir(parents=True,exist_ok=True); Path(out).write_text('\n'.join(fm)+body,encoding='utf-8')
    return {'title':title,'source':str(src),'output':str(out),'formulas':body.count('$'),'code_blocks':body.count('\n```'),'images':re.findall(r'!\[[^]]*\]\(([^)]+)\)',body)}

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--source',required=True); ap.add_argument('--output',required=True); ap.add_argument('--private-output'); args=ap.parse_args()
    root=Path(args.source); out=Path(args.output)
    entries=[
      ('2021/10/26/math-primes/index.html','数论：质数与约数','2021-10-26','/2021/10/26/math-primes/',['算法','数学']),
      ('2021/10/27/kuo-zhan-ou-ji-li-de-suan-fa/index.html','扩展欧几里得算法','2021-10-27','/2021/10/27/kuo-zhan-ou-ji-li-de-suan-fa/',['算法']),
      ('2021/11/06/pai-lie-zu-he/index.html','排列组合','2021-11-06','/2021/11/06/pai-lie-zu-he/',['算法','数学']),
    ]
    report=[]
    for rel,title,date,alias,tags in entries:
        safe=re.sub(r'[^\w\u4e00-\u9fff-]+','-',title).strip('-')
        report.append(convert(root/rel,title,date,alias,tags,out/(safe+'.md')))
    private_src=root/'2021/10/22/hui-yi-lu/index.html'
    private_out=Path(args.private_output or '/tmp/peilin-private/index.md')
    convert(private_src,'培琳','2021-10-22','',['私密'],private_out,True)
    (Path(__file__).parent/'legacy-extraction-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
