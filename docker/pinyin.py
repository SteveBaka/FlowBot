import sys
from pypinyin import pinyin, Style

def to_pinyin(text):
    return ''.join([p[0] for p in pinyin(text, style=Style.NORMAL)])

if __name__ == '__main__':
    text = sys.argv[1] if len(sys.argv) > 1 else ''
    print(to_pinyin(text))
