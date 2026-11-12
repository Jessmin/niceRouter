import { config } from '../config.js';
import { createQoderAdapter } from './qoder.js';

export const qoderIntlAdapter = createQoderAdapter({
  name: 'qoder-intl',
  getConfig: () => config.qoderIntl,
  getModels: () => config.qoderIntlModels,
});
