import type { TiptapDocument } from '../src';

/** A document that exercises every email and Liquid block the editor can produce. */
export const newsletter: TiptapDocument = {
  type: 'doc',
  content: [
    { type: 'emailPreheader', attrs: { text: 'News for {{ contact.first_name }}' } },
    {
      type: 'emailHeader',
      content: [
        {
          type: 'image',
          attrs: {
            src: 'https://cdn.example.com/logo.png',
            alt: 'Logo',
            width: 120,
            href: 'https://example.com',
          },
        },
      ],
    },
    {
      type: 'heading',
      attrs: { level: 1, textAlign: 'center' },
      content: [{ type: 'text', text: 'Autumn news' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hi ' },
        {
          type: 'liquidVariable',
          attrs: {
            path: 'contact.first_name',
            fallback: 'there',
            label: 'First name',
            filter: null,
          },
        },
        { type: 'text', text: ', here is what is ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'new' },
        { type: 'text', text: ' — read the ' },
        {
          type: 'text',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/blog?a=1&b=2' } }],
          text: 'blog',
        },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Faster search' }] }],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New reports' }] }],
        },
      ],
    },
    {
      type: 'emailButton',
      attrs: {
        label: 'Open the app',
        href: 'https://example.com/app',
        align: 'center',
        backgroundColor: '#16a34a',
        textColor: '#ffffff',
      },
    },
    { type: 'emailSpacer', attrs: { height: 16 } },
    {
      type: 'emailColumns',
      content: [
        {
          type: 'emailColumn',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Left column' }] }],
        },
        {
          type: 'emailColumn',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Right column' }] }],
        },
      ],
    },
    { type: 'horizontalRule' },
    {
      type: 'liquidCondition',
      attrs: {
        kind: 'tag',
        tag: 'VIP',
        field: null,
        operator: 'equals',
        value: null,
        expression: null,
        negate: false,
      },
      content: [
        {
          type: 'liquidBranch',
          attrs: { branch: 'then' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Thanks for being a VIP.' }] },
          ],
        },
        {
          type: 'liquidBranch',
          attrs: { branch: 'else' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Upgrade to VIP today.' }] },
          ],
        },
      ],
    },
    {
      type: 'liquidRaw',
      attrs: {
        code: '{% if order.total > 100 %}<p>Free shipping on your next order.</p>{% endif %}',
      },
    },
    {
      type: 'emailFooter',
      attrs: { unsubscribeLabel: 'Unsubscribe from these emails' },
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'You receive this because you signed up.' }],
        },
      ],
    },
  ],
};

export const vipContext = {
  contact: { first_name: 'Ada', tags: ['VIP'] },
  order: { total: 150 },
  unsubscribe_url: 'https://t.example.com/unsub/tok_vip',
};

export const regularContext = {
  contact: { first_name: '', tags: [] },
  order: { total: 20 },
  unsubscribe_url: 'https://t.example.com/unsub/tok_regular',
};
