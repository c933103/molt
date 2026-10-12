"""Check the HTML 4.0 Strict subset used by this client; not a general SGML validator."""
from html.parser import HTMLParser
from pathlib import Path
import re
import sys

COMMON = {'id', 'class', 'title', 'lang', 'dir'}
ATTRS = {
    'html': {'lang', 'dir'}, 'head': {'lang', 'dir', 'profile'},
    'title': {'lang', 'dir'}, 'meta': {'name', 'http-equiv', 'content', 'scheme', 'lang', 'dir'},
    'body': COMMON, 'h1': COMMON, 'h2': COMMON, 'h3': COMMON,
    'div': COMMON, 'p': COMMON, 'strong': COMMON, 'ol': COMMON, 'li': COMMON,
    'noscript': set(), 'pre': COMMON, 'hr': COMMON, 'br': COMMON,
    'label': COMMON | {'for', 'accesskey'},
    'input': COMMON | {'type', 'name', 'value', 'size', 'maxlength', 'disabled', 'readonly', 'tabindex', 'accesskey'},
    'button': COMMON | {'type', 'name', 'value', 'disabled', 'tabindex', 'accesskey'},
    'select': COMMON | {'name', 'size', 'multiple', 'disabled', 'tabindex'},
    'option': {'id', 'class', 'title', 'lang', 'dir', 'selected', 'disabled', 'label', 'value'},
    'textarea': COMMON | {'name', 'rows', 'cols', 'disabled', 'readonly', 'tabindex', 'accesskey'},
    'a': COMMON | {'href', 'name', 'rel', 'rev', 'charset', 'hreflang', 'type', 'accesskey', 'tabindex'},
    'script': {'type', 'src', 'charset', 'defer'},
}
VOID = {'meta', 'input', 'br', 'hr'}
BLOCK = {'h1', 'h2', 'h3', 'div', 'p', 'ol', 'li', 'noscript', 'pre', 'hr'}

class Checker(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.stack, self.ids, self.labels, self.doctype = [], set(), [], False

    def handle_decl(self, declaration):
        assert declaration == 'DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0//EN" "https://www.w3.org/TR/1998/REC-html40-19980424/strict.dtd"', 'Use the dated HTML 4.0 Strict declaration'
        self.doctype = True

    def handle_starttag(self, tag, attrs):
        assert tag in ATTRS, f'Unsupported HTML 4.0 client element: {tag}'
        names = [name for name, _ in attrs]
        assert len(names) == len(set(names)), f'Duplicate attribute on {tag}'
        assert set(names) <= ATTRS[tag], f'Unsupported attributes on {tag}: {set(names) - ATTRS[tag]}'
        values = dict(attrs)
        parent = self.stack[-1] if self.stack else None
        if parent == 'p': assert tag not in BLOCK, f'Block element {tag} inside P'
        if tag == 'li': assert parent == 'ol', 'LI must be inside OL in this client'
        if tag == 'option': assert parent == 'select', 'OPTION must be inside SELECT'
        if tag in {'meta', 'title'}: assert parent == 'head', f'{tag} must be in HEAD'
        if tag == 'textarea':
            assert {'rows', 'cols'} <= values.keys(), 'TEXTAREA needs ROWS and COLS'
        if tag == 'script': assert values.get('type') == 'text/javascript', 'SCRIPT needs its HTML 4.0 TYPE'
        if tag == 'button': assert values.get('type') == 'button', 'Only non-submitting buttons are used'
        if tag == 'input': assert values.get('type') in {'text', 'password'}, 'Unsupported input type'
        if 'id' in values:
            assert values['id'] not in self.ids, 'Duplicate ID'
            self.ids.add(values['id'])
        if tag == 'label': self.labels.append(values.get('for'))
        if tag not in VOID: self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        raise AssertionError('Use HTML 4.0 empty-element syntax without a closing slash')

    def handle_endtag(self, tag):
        assert self.stack and self.stack[-1] == tag, f'Misnested closing tag: {tag}'
        self.stack.pop()

    def finish(self):
        self.close()
        assert self.doctype and not self.stack, 'Missing declaration or closing tags'
        assert all(target in self.ids for target in self.labels), 'A label references a missing control'

def check(text):
    parser = Checker(); parser.feed(text); parser.finish()
    assert not re.search(r'<style\b|\bstyle\s*=|<link\b[^>]*stylesheet', text, re.I), 'The client must contain no CSS'
    script = re.search(r'<script\b[^>]*>([\s\S]*?)</script>', text).group(1)
    assert not re.search(r'\.style\b|\.hidden\b|\.dataset\b|setAttribute\([\'"](?:style|hidden|data-|aria-)', script), 'Do not generate CSS or HTML5-only interface attributes'

if __name__ == '__main__':
    check(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name('index.html')).read_text())
    print('HTML 4.0 client markup and no-CSS checks passed')
