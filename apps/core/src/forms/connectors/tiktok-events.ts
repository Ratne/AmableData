import { tiktokEventsConfigSchema } from '@amable/api-types';
import { adConversionConnector } from './ad-conversion';

/** TikTok Events API 2.0: every submission becomes a server-side web event on the pixel. */
export const tiktokEventsConnector = adConversionConnector('tiktok_events', 'tiktok', tiktokEventsConfigSchema);
