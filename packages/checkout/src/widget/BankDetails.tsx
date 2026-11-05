import { useState } from 'preact/hooks';
import type { BankTransferDetails } from '../public';
import { formatMoney, type CheckoutLocale, type CheckoutStrings } from '../strings';

/** Where and how much to transfer, shown after a bank transfer purchase (also emailed to the buyer). */
export function BankDetails({
  details,
  strings,
  locale,
}: {
  details: BankTransferDetails;
  strings: CheckoutStrings;
  locale: CheckoutLocale;
}) {
  const money = (minor: number) => formatMoney(minor, details.currency, locale);
  /** Label, shown value, value copied (null: no copy button). */
  const rows: Array<[string, string, string | null]> = [
    [strings.bankHolder, details.holder, null],
    [strings.bankIban, details.iban, details.iban.replace(/\s+/g, '')],
    [strings.bankBic, details.bic, null],
    [strings.bankName, details.bank_name, null],
    [strings.bankAmount, money(details.total_minor), null],
    [strings.bankReference, details.reference, details.reference],
  ];
  return (
    <div class="ac-bank">
      {rows
        .filter(([, value]) => value !== '')
        .map(([label, value, copy]) => (
          <div class="ac-line" key={label}>
            <span>{label}</span>
            <span class="ac-bank-value">
              {value}
              {copy !== null ? <Copy value={copy} strings={strings} /> : null}
            </span>
          </div>
        ))}
      {details.orders.length > 1
        ? details.orders.map((o) => (
            <div class="ac-line ac-muted" key={o.number}>
              <span>{o.number}</span>
              <span>{money(o.total_minor)}</span>
            </div>
          ))
        : null}
      {details.instructions !== '' ? <div class="ac-muted">{details.instructions}</div> : null}
      <div class="ac-muted">{strings.bankEmailNote}</div>
    </div>
  );
}

function Copy({ value, strings }: { value: string; strings: CheckoutStrings }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="ac-link"
      style="margin-left:8px"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? strings.copied : strings.copy}
    </button>
  );
}
