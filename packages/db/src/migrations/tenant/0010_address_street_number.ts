import type { Migration } from '../types';

/** House number kept apart from the street name (`line1`), as most address forms and geocoders split them. */
export const t0010AddressStreetNumber: Migration = {
  id: 10,
  name: 'address_street_number',
  statements: [`ALTER TABLE crm_contact_addresses ADD COLUMN street_number TEXT`],
};
