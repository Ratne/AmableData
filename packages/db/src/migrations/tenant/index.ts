import type { Migration } from '../types';
import { t0001Init } from './0001_init';
import { t0002CrmCore } from './0002_crm_core';
import { t0003CrmSearch } from './0003_crm_search';
import { t0004Commerce } from './0004_commerce';
import { t0005Forms } from './0005_forms';
import { t0006Booking } from './0006_booking';
import { t0007Pages } from './0007_pages';
import { t0008Folders } from './0008_folders';
import { t0009FormSubmissionsContact } from './0009_form_submissions_contact';
import { t0010AddressStreetNumber } from './0010_address_street_number';
import { t0011Apps } from './0011_apps';
import { t0012Conversations } from './0012_conversations';
import { t0013ConversationTemplates } from './0013_conversation_templates';
import { t0014DropMapboxSettings } from './0014_drop_mapbox_settings';
import { t0015SheetsServiceAccount } from './0015_sheets_service_account';
import { t0016Esign } from './0016_esign';
import { t0017Checkout } from './0017_checkout';
import { t0018Archive } from './0018_archive';
import { t0019BookingWeights } from './0019_booking_weights';
import { t0020BookingPolicies } from './0020_booking_policies';

/**
 * Ordered list of tenant-DO SQLite migrations.
 * Applied automatically on first access of each TenantDb Durable Object.
 */
export const tenantMigrations: readonly Migration[] = [
  t0001Init,
  t0002CrmCore,
  t0003CrmSearch,
  t0004Commerce,
  t0005Forms,
  t0006Booking,
  t0007Pages,
  t0008Folders,
  t0009FormSubmissionsContact,
  t0010AddressStreetNumber,
  t0011Apps,
  t0012Conversations,
  t0013ConversationTemplates,
  t0014DropMapboxSettings,
  t0015SheetsServiceAccount,
  t0016Esign,
  t0017Checkout,
  t0018Archive,
  t0019BookingWeights,
  t0020BookingPolicies,
];
