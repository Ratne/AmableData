# @amable/booking

Availability engine (weekly hours and date overrides in the calendar's IANA time zone, buffers,
minimum notice, horizon, daily caps, round robin / collective hosts — `Intl` only, DST-correct),
answer validation, public booking types, widget strings (en/it) and the edge ↔ core gateway op
types (`BookingGatewayOps`).

The embeddable widget (preact) lives in `src/widget` and is bundled by `pnpm --filter @amable/booking build`
into `generated/bundle.ts` (`BOOKING_WIDGET_BUNDLE`, `BOOKING_WIDGET_BUNDLE_HASH`), exported as
`@amable/booking/bundle`. Rebuild and commit it after changing the widget.
