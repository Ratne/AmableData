/** English strings of Settings > Billing & wallet (spread into the main catalog). */
export const billingEn = {
  'billing.title': 'Billing & wallet',
  'billing.ownerOnly': 'Only the workspace owner can see billing and the wallet.',
  'billing.plan.title': 'Plan',
  'billing.plan.managed': 'Managed',
  'billing.plan.managedPrice': '{price}/month',
  'billing.plan.managedBody':
    'Automatic installation and updates, error and health monitoring, central services, included email quota and support. Cloudflare usage is billed on your Cloudflare account.',
  'billing.plan.openSource': 'Open source',
  'billing.plan.state': 'Service',
  'billing.plan.periodEnd': 'Renews on',
  'billing.plan.unknownState': 'Not available yet',
  'billing.state.trial': 'Trial',
  'billing.state.active': 'Active',
  'billing.state.grace': 'Grace period',
  'billing.state.suspended': 'Suspended',
  'billing.state.self_hosted': 'Self-hosted',
  'billing.state.graceBody':
    'The last payment failed. Update your payment method in the portal: after the grace period updates, system emails and central services stop. Your installation and data are never touched.',
  'billing.state.suspendedBody':
    'Central services are stopped because the subscription is unpaid: email sends are blocked and automatic updates are paused. Your data stays available. Settle the payment in the portal to resume.',
  'billing.email.title': 'Email quota',
  'billing.email.used': '{used} of {included} included emails used',
  'billing.email.remaining': 'Remaining',
  'billing.email.period': 'Period',
  'billing.email.periodRange': '{start} – {end}',
  'billing.email.overage': 'Beyond the quota',
  'billing.email.overagePrice': '{price} every 1,000 emails',
  'billing.email.caps': 'Sending limits',
  'billing.email.capsValue': '{hourly} per hour, {daily} per day',
  'billing.email.noCap': 'no limit',
  'billing.email.explain':
    'The included quota resets at every renewal. Beyond it, emails are paid from the wallet at {price} every 1,000. Before a broadcast starts its cost is estimated: if the balance does not cover it, the send does not start; automation emails pause when the wallet is empty and resume after a top-up.',
  'billing.email.increase': 'Increase capacity',
  'billing.email.unavailable':
    'Quota data is not available yet: it appears after the first contact with the platform.',
  'billing.wallet.title': 'Wallet',
  'billing.wallet.balance': 'Available balance',
  'billing.wallet.lowTitle': 'Low balance',
  'billing.wallet.low':
    'The balance does not cover {count} emails beyond the included quota ({cost}). Top up to avoid blocked broadcasts and paused automation emails.',
  'billing.wallet.explain':
    'Prepaid credit for usage beyond the plan (emails beyond the quota, future AI features). Top-ups, automatic recharge and invoices are managed in the portal.',
  'billing.wallet.unavailable': 'The balance is not available yet.',
  'billing.wallet.topUp': 'Top up wallet',
  'billing.wallet.manage': 'Manage payments and invoices',
  'billing.openSource.title': 'Open source installation',
  'billing.openSource.body':
    'This installation is self-hosted and free: you install and update it yourself, with your own email providers and OAuth apps. Central services (managed updates, system email service, verified OAuth apps, support) are not included.',
  'billing.openSource.connect':
    'You can connect a platform account to buy credits for paid services, such as AI tokens for analytics in the future.',
  'billing.openSource.connectButton': 'Connect an account',
  'billing.openSource.linked':
    'This installation is linked to a platform account: paid services are charged to the wallet below.',
  'billing.stale.title': 'Data may be out of date',
  'billing.stale.body': 'The platform cannot be reached right now. Last update: {date}.',
  'billing.missing.body':
    'The platform has not sent quota and wallet data yet. Sends are not blocked in the meantime.',
} as const;

export type BillingMessageKey = keyof typeof billingEn;
