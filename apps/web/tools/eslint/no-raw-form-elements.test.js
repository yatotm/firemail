import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { noRawFormElements } from './no-raw-form-elements.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
    },
  },
});

describe('firemail/no-raw-form-elements', () => {
  it('挡住原生表单元素，放行基元与 disable 注释', () => {
    ruleTester.run('no-raw-form-elements', noRawFormElements, {
      valid: [
        // 基元本身（首字母大写的组件）永远可以用
        { code: 'const A = () => <Input value="" />;' },
        { code: 'const A = () => <Select><SelectOption value="x" /></Select>;' },
        { code: 'const A = () => <Textarea rows={3} />;' },
        { code: 'const A = () => <Checkbox checked />;' },
        // 非表单的原生元素不受影响
        { code: 'const A = () => <div><button type="button" /><label /></div>;' },
        // 确实不可见的元素靠 disable 注释单独放行
        {
          code: [
            'const A = () => (',
            '  // eslint-disable-next-line rule-to-test/no-raw-form-elements -- 隐藏的文件选择器',
            '  <input type="file" className="hidden" />',
            ');',
          ].join('\n'),
        },
      ],
      invalid: [
        {
          code: 'const A = () => <input type="text" />;',
          errors: [{ messageId: 'raw' }],
        },
        {
          code: 'const A = () => <select><option value="a" /></select>;',
          errors: [{ messageId: 'raw' }],
        },
        {
          code: 'const A = () => <textarea rows={4} />;',
          errors: [{ messageId: 'raw' }],
        },
        {
          // 手抄一份「像 Input 的 input」正是这条规则要挡的漂移
          code: 'const A = () => <input className="rounded-md border border-input focus-visible:ring-[3px]" />;',
          errors: 1,
        },
      ],
    });
  });
});
