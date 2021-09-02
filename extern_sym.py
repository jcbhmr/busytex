import sys;

syms = set(filter(bool, sys.argv[2:]))

lines = []
with open(sys.argv[1]) as f:
    for l in f:

        symok = False
        for sym in syms:
            if (' ' + sym + ' ') in l or (' ' + sym + '[') in l:
                print('SYM [', sym, '] in [', l, ']', file = sys.stderr)
                symok = True

        if symok and l.startswith('EXTERN'):
            lines.append(l.replace('EXTERN', 'extern'))
        elif symok:
            lines.append(l.replace('  ', '  extern'))
        else:
            lines.append(l)

with open(sys.argv[1], 'w') as f:
    f.writelines(lines)