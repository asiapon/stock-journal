# SKILL.md 技能包合成器（由 deploy/skillpack.js 调用）
# 用法：python synth.py <SKILL.md 路径> <输出 .py 路径>
# 逐代码块 ast.parse：合法块只保留顶层 import / def / class / 安全常量赋值 / try-import，
# 过滤用法示例（顶层 print / for / 会发请求的调用式赋值），ast.unparse 重新生成 —— 保证语法正确。
import ast
import re
import sys

# 模块级赋值允许的「无副作用」构造调用：re.compile / 容器 / Session（不发网络请求）
SAFE_CALLS = {'compile', 'dict', 'list', 'set', 'tuple', 'defaultdict', 'OrderedDict',
              'frozenset', 'Session', 'dedent', 'NamedTuple'}


def _safe_value(node) -> bool:
    """模块级赋值右值是否「纯数据」：字面量 / 容器递归 / 属性访问 / 白名单构造调用。"""
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.Attribute, ast.Name)):
        return True  # 属性访问（re.X / re.IGNORECASE）与名字引用本身无副作用
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return all(_safe_value(e) for e in node.elts)
    if isinstance(node, ast.Dict):
        return all((k is None or _safe_value(k)) and _safe_value(v) for k, v in zip(node.keys, node.values))
    if isinstance(node, ast.JoinedStr):
        return all(isinstance(v, ast.Constant) for v in node.values)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd, ast.Not)):
        return _safe_value(node.operand)
    if isinstance(node, ast.BinOp):
        return _safe_value(node.left) and _safe_value(node.right)
    if isinstance(node, ast.Call):
        fn = node.func
        name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, 'id', '')
        return name in SAFE_CALLS and all(_safe_value(a) for a in node.args) \
            and all(_safe_value(kw.value) for kw in node.keywords)
    return False


def main(md_path: str, out_path: str) -> int:
    md = open(md_path, encoding='utf-8').read()
    blocks = re.findall(r'```python\r?\n([\s\S]*?)```', md)
    parts = []
    skipped = 0
    for b in blocks:
        try:
            tree = ast.parse(b)
        except SyntaxError:
            skipped += 1
            continue
        keep = []
        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef,
                                 ast.AsyncFunctionDef, ast.ClassDef, ast.Try)):
                keep.append(node)
            elif isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) for t in node.targets) \
                    and _safe_value(node.value):
                keep.append(node)  # 模块级字面量 / 安全构造常量（如 ZTB_UT、_TICKER_RE = re.compile(...)）；
                # 调用式赋值（client = tdx_client()）会在 import 时执行网络请求，必须剔除
            elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                    and isinstance(node.value.value, str):
                keep.append(node)  # 模块 docstring
            else:
                skipped += 1
        if keep:
            parts.append(ast.unparse(ast.Module(body=keep, type_ignores=[])))
    if not parts:
        print('ERROR: 没有可合成的 Python 代码块', file=sys.stderr)
        return 2
    out = ('# 由 stock-journal 自托管后端从 SKILL.md 合成（ast 级过滤，语法保证正确）\n'
           '# 来源遵循原项目许可（a-stock-data: Apache-2.0）\n' + '\n\n'.join(parts) + '\n')
    open(out_path, 'w', encoding='utf-8').write(out)
    # 函数清单写 stdout 最后一行 JSON（供 Node 侧读取）
    import json
    tree = ast.parse(out)
    fns = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and not node.name.startswith('_'):
            doc = ast.get_docstring(node) or ''
            fns.append({'name': node.name, 'doc': doc.strip().split('\n')[0][:120]})
    print('===META===')
    print(json.dumps({'blocks': len(blocks), 'kept': len(parts), 'functions': fns},
                     ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
