// Side-effect entry for server renderers: registers every Phosphor weight.
import { registerPhosphor } from '../icons';
import bold from './bold';
import duotone from './duotone';
import fill from './fill';
import light from './light';
import regular from './regular';
import thin from './thin';

registerPhosphor('regular', regular);
registerPhosphor('thin', thin);
registerPhosphor('light', light);
registerPhosphor('bold', bold);
registerPhosphor('fill', fill);
registerPhosphor('duotone', duotone);
