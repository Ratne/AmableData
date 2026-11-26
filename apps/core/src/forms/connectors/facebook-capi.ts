import { facebookCapiConfigSchema } from '@amable/api-types';
import { adConversionConnector } from './ad-conversion';

/** Meta Conversions API: every submission becomes a server-side event on the pixel (dataset). */
export const facebookCapiConnector = adConversionConnector('facebook_capi', 'meta', facebookCapiConfigSchema);
