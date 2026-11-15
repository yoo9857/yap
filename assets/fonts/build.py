# The menu screens' own copy of Jua, holding only the letters those screens show.
#
# The first page's largest thing is its headline, and it was drawn late: the page waited for Google's
# stylesheet, then for the Korean pieces of Jua it names (the live site, 2026-11-15: the headline's
# paint at 1.1 - 4.1 s). So the letters of the first page, the mode choice and the loader (what is
# written in index.html for them) are cut out of Jua (SIL Open Font License, OFL.txt) into one small
# file the page preloads: apps/client/public/fonts/jua-menu.woff2, family "Jua Menu", first in the
# menu screens' font stacks. A letter it does not hold (a note's title in the news, the later
# screens' words, a class name someone types) falls through to Google's Jua as before.
#
#   python assets/fonts/build.py            # write the file
#   python assets/fonts/build.py --check    # fail if it is stale (text changed: run it again)
#
# Needs fonttools and brotli (pip install fonttools brotli).
import io, os, re, sys, html as htmllib
from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(HERE, 'Jua-Regular.ttf')
OUT = os.path.join(ROOT, 'apps', 'client', 'public', 'fonts', 'jua-menu.woff2')
LIST = os.path.join(HERE, 'jua-menu.txt')   # the letters it holds, committed: --check compares against it

def letters():
    page = io.open(os.path.join(ROOT, 'apps', 'client', 'index.html'), encoding='utf-8').read()
    # the first page and the mode choice (the two screens before any other download has had time), and the loader
    first = page[page.index('<div class="mode-step web-home"'):page.index('<div class="hub-shell">')]
    loader = page[page.index('<div id="boot-overlay"'):]
    body = re.sub(r'<script.*?</script>|<svg.*?</svg>', ' ', first + loader, flags=re.S)
    text = htmllib.unescape(re.sub(r'<[^>]+>', ' ', body))
    text += ' '.join(re.findall(r'(?:aria-label|placeholder|alt)="([^"]*)"', body))
    have = TTFont(SRC).getBestCmap()
    basic = ''.join(chr(c) for c in range(0x20, 0x7f)) + '·…—–→←↑↓✓×“”‘’'
    return ''.join(sorted(ch for ch in set(text + basic) if ord(ch) in have and ord(ch) >= 0x20))

def main():
    chars = letters()
    if '--check' in sys.argv:
        old = io.open(LIST, encoding='utf-8').read() if os.path.exists(LIST) else ''
        missing = sorted(set(chars) - set(old))
        if missing or not os.path.exists(OUT):
            print('jua-menu.woff2 is stale: missing', ''.join(missing) or '(the file)', '\nrun: python assets/fonts/build.py')
            sys.exit(1)
        print('jua-menu.woff2 holds every letter of the menu screens (%d).' % len(old))
        return
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    options.name_IDs = [1, 2]
    options.notdef_outline = True
    font = subset.load_font(SRC, options)
    sub = subset.Subsetter(options)
    sub.populate(text=chars)
    sub.subset(font)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    subset.save_font(font, OUT, options)
    io.open(LIST, 'w', encoding='utf-8', newline='').write(chars)
    print('%s: %d letters, %d KB' % (os.path.relpath(OUT, ROOT), len(chars), os.path.getsize(OUT) // 1024))

main()
