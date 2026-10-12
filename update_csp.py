"""Update the single-page content security policy after source changes."""
import base64
import hashlib
from pathlib import Path
import re

path = Path(__file__).with_name('index.html')
html = path.read_text()
def digest(tag):
    text = re.search(rf'<{tag}>([\s\S]*?)</{tag}>', html).group(1)
    return base64.b64encode(hashlib.sha256(text.encode()).digest()).decode()

csp = "default-src 'none'; script-src 'sha256-" + digest('script') + "'; style-src 'sha256-" + digest('style') + "'; connect-src https://www.moltbook.com; base-uri 'none'; form-action 'none'; object-src 'none'"
html = re.sub(r'(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)', lambda m: m.group(1) + csp + m.group(2), html)
path.write_text(html)
