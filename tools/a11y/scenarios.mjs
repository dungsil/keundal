import ts from 'typescript'

export function scenarioTitles(source, path = 'scenario.spec.ts') {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const titles = []
  const visit = (node, skipped = false) => {
    const isCall = ts.isCallExpression(node)
    const expression = isCall ? node.expression.getText(ast) : ''
    const disabled = skipped || /^test\.(?:describe\.)?(?:skip|fixme)$/.test(expression)
    if (!disabled && isCall && expression === 'test' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      titles.push(node.arguments[0].text)
    }
    ts.forEachChild(node, (child) => visit(child, disabled))
  }
  visit(ast)
  return titles
}
