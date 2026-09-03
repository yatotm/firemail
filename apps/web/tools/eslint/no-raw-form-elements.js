/**
 * 禁止在 `components/ui/` 之外直接写原生表单元素。
 *
 * 为什么要有这条规则：焦点环、边框、圆角、禁用态、非法态原本被复制粘贴在 5 个文件里，
 * 每个副本都略有出入（3px 的 ring 对 2px 的 outline），改一处修不完。
 * 现在这些外观只在 `styles/globals.css` 定义一次、由 `components/ui/` 的基元套用；
 * 功能代码只准用基元，否则漂移会悄悄长回来。
 *
 * 真正不可见、也没有基元可套的元素（隐藏的文件选择器、给密码管理器用的隐藏
 * username 字段）用 `eslint-disable-next-line` 单独放行，并且必须写明理由。
 */

/** @type {Record<string, string>} */
const REPLACEMENTS = {
  input: 'Input / Checkbox / RadioGroup（@/components/ui/*）',
  select: 'Select（@/components/ui/select）',
  textarea: 'Textarea（@/components/ui/textarea）',
};

/** @type {import('eslint').Rule.RuleModule} */
export const noRawFormElements = {
  meta: {
    type: 'problem',
    docs: {
      description: '功能代码里只准用 components/ui 的表单基元，不许直接写原生表单元素',
    },
    schema: [],
    messages: {
      raw: '不要直接用 <{{name}}>，请用 {{replacement}}。样式只在 globals.css 定义一次，复制一份就会漂移。确实不可见的元素请用 eslint-disable-next-line 并写明理由。',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const name = node.name;
        if (name.type !== 'JSXIdentifier') return;
        const replacement = REPLACEMENTS[name.name];
        if (!replacement) return;
        context.report({
          node: name,
          messageId: 'raw',
          data: { name: name.name, replacement },
        });
      },
    };
  },
};

/** @type {import('eslint').ESLint.Plugin} */
export const firemailPlugin = {
  rules: { 'no-raw-form-elements': noRawFormElements },
};
