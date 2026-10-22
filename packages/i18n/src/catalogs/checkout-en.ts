/**
 * Checkout builder UI strings (list, editor tabs, bumps, post-purchase
 * offers, embed). Spread into the English catalog; checkout-it.ts must cover
 * every key.
 */

export const checkoutEn = {
  'nav.checkouts': 'Checkouts',

  'checkout.status.draft': 'Draft',
  'checkout.status.active': 'Active',
  'checkout.status.archived': 'Archived',
  'checkout.status.notArchived': 'Draft and active',

  'checkout.list.new': 'New checkout',
  'checkout.list.create': 'Create checkout',
  'checkout.list.empty': 'No checkouts yet. Create one to sell products and plans from your landing pages.',
  'checkout.list.nameHint': 'Internal name, shown on the order source.',
  'checkout.list.duplicated': 'Checkout duplicated',
  'checkout.list.content': '{items} items · {bumps} bumps · {offers} offers',
  'checkout.action.duplicate': 'Duplicate',
  'checkout.action.moveUp': 'Move up',
  'checkout.action.moveDown': 'Move down',

  'checkout.field.paid': 'Paid orders',
  'checkout.field.revenue': 'Revenue',
  'checkout.field.content': 'Content',
  'checkout.field.updated': 'Updated',
  'checkout.field.price': 'Price',
  'checkout.field.catalogPrice': 'Catalog price: {price}',
  'checkout.field.priceCatalog': 'Catalog price',
  'checkout.field.label': 'Label',
  'checkout.field.labelHint': 'Empty uses the catalog name.',
  'checkout.field.imageUrl': 'Image URL',

  'checkout.tab.products': 'Products',
  'checkout.tab.fields': 'Fields',
  'checkout.tab.bumps': 'Bumps',
  'checkout.tab.offers': 'Post-purchase',
  'checkout.tab.design': 'Design',
  'checkout.tab.settings': 'Settings',

  'checkout.items.addProduct': 'Add product',
  'checkout.items.addPlan': 'Add plan',
  'checkout.items.selection': 'Buyer choice',
  'checkout.items.selection.all': 'Buy everything',
  'checkout.items.selection.one': 'Choose one',
  'checkout.items.selection.all.hint': 'Every item is bought together.',
  'checkout.items.selection.one.hint': 'The buyer picks one item (e.g. a monthly or a yearly plan).',
  'checkout.items.allowQuantity': 'Let the buyer change quantities',
  'checkout.items.empty': 'Add at least one product or plan.',
  'checkout.items.kind.product': 'Product',
  'checkout.items.kind.plan': 'Plan',
  'checkout.items.preselected': 'Preselected',

  'checkout.bumps.add': 'Add bump',
  'checkout.bumps.intro': 'Order bumps are extra products the buyer adds with one checkbox, right on the checkout.',
  'checkout.bumps.defaultTitle': 'Yes, add this to my order',
  'checkout.bumps.title': 'Headline',
  'checkout.bumps.skin': 'Style',
  'checkout.bumps.skin.classic': 'Classic',
  'checkout.bumps.skin.highlight': 'Highlight',
  'checkout.bumps.skin.dashed': 'Dashed',
  'checkout.bumps.skin.minimal': 'Minimal',
  'checkout.bumps.skin.ribbon': 'Ribbon',
  'checkout.bumps.position': 'Position',
  'checkout.bumps.position.below_items': 'Below the products',
  'checkout.bumps.position.above_payment': 'Above the payment',
  'checkout.bumps.position.below_payment': 'Below the payment',
  'checkout.bumps.color': 'Accent color',
  'checkout.bumps.colorHint': 'Empty uses the checkout color.',
  'checkout.bumps.checked': 'Checked by default',

  'checkout.offers.addUpsell': 'Add upsell',
  'checkout.offers.addDownsell': 'Add downsell',
  'checkout.offers.intro':
    'After the payment the buyer sees these offers one at a time: accepting charges the saved card with one click, without entering it again. Each answer leads to the next offer or to the thank-you page.',
  'checkout.offers.first': 'First offer',
  'checkout.offers.firstHint': 'Shown right after the payment.',
  'checkout.offers.none': 'None (go to the thank-you page)',
  'checkout.offers.window': 'Time to accept (minutes)',
  'checkout.offers.windowHint': 'After this the one-click link expires.',
  'checkout.offers.kind': 'Type',
  'checkout.offers.kind.upsell': 'Upsell',
  'checkout.offers.kind.downsell': 'Downsell',
  'checkout.offers.itemKind': 'What it sells',
  'checkout.offers.pageUrl': 'Offer page URL',
  'checkout.offers.pageUrlHint':
    'A landing page with the offer block. Empty uses the built-in offer page.',
  'checkout.offers.onAccept': 'If accepted',
  'checkout.offers.onDecline': 'If declined',
  'checkout.offers.thankYou': 'Thank-you page',
  'checkout.offers.defaultUpsell': 'Special offer',
  'checkout.offers.defaultDownsell': 'Last chance',

  'checkout.contact.title': 'Buyer details',
  'checkout.contact.name': 'Name',
  'checkout.contact.phone': 'Phone',
  'checkout.contact.company': 'Company',
  'checkout.contact.address': 'Billing address',
  'checkout.contact.mode.required': 'Required',
  'checkout.contact.mode.optional': 'Optional',
  'checkout.contact.mode.hidden': 'Hidden',
  'checkout.contact.defaultCountry': 'Default country',
  'checkout.contact.autocomplete': 'Address autocomplete',
  'checkout.contact.emailAlways': 'The email is always required: it identifies the contact in the CRM.',
  'checkout.fields.custom': 'Custom fields',
  'checkout.fields.prefillHint':
    'Each field is prefilled from the page URL query parameter with the same name (e.g. ?email=…). UTM parameters are always saved on the order.',

  'checkout.design.layout': 'Layout',
  'checkout.design.layout.two_columns': 'Two columns',
  'checkout.design.layout.one_column': 'One column',
  'checkout.design.summaryBackground': 'Summary background',

  'checkout.settings.purchase': 'Purchase',
  'checkout.settings.heading': 'Heading',
  'checkout.settings.button_label': 'Pay button',
  'checkout.settings.success_message': 'Success message',
  'checkout.settings.terms_label': 'Terms checkbox label',
  'checkout.settings.defaultHint': 'Empty uses the default text in the buyer language.',
  'checkout.settings.promoCodes': 'Accept promo codes',
  'checkout.settings.promoParam': 'URL parameter',
  'checkout.settings.promoParamHint': 'A link with ?{param}=CODE applies the code automatically.',
  'checkout.settings.thankYouUrl': 'Thank-you page URL',
  'checkout.settings.thankYouHint': 'Empty shows the success message in place.',
  'checkout.settings.termsUrl': 'Terms URL',
  'checkout.settings.termsHint': 'When set, the buyer must accept the terms to pay.',
  'checkout.settings.hosted': 'Hosted page (a link that works without a landing page)',
  'checkout.settings.tagsHint':
    'Added once the payment succeeds (a declined card adds none). The contact, its owner and lead source are saved as soon as the buyer submits.',
  'checkout.settings.attribution':
    'Orders keep the UTM parameters and the referrer of the page, and the contact is linked to the checkout as source.',

  'checkout.editor.saved': 'Saved',
  'checkout.editor.noItems': 'An active checkout without products cannot be bought.',

  'checkout.preview.title': 'Preview',
  'checkout.preview.unavailable': 'The preview could not be loaded.',

  'checkout.embed.title': 'Embed',
  'checkout.embed.snippet': 'Checkout snippet',
  'checkout.embed.offerSnippet': 'Offer snippet',
  'checkout.embed.offerHint':
    'Paste it on the page of each upsell or downsell: it shows the offer and its accept and decline buttons.',
  'checkout.embed.hosted': 'Hosted page',
  'checkout.embed.open': 'Open',
  'checkout.embed.unsaved': 'Save to publish the latest changes.',
  'checkout.embed.landingHint':
    'In the landing page editor, use the Checkout and Checkout offer blocks: no code needed.',
} as const;

export type CheckoutMessageKey = keyof typeof checkoutEn;
