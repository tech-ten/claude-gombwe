import { Ledger } from './ledger.js';
import type { GombweConfig } from './types.js';

export interface Services {
  ledger: Ledger;
}

export function createServices(config: GombweConfig): Services {
  return { ledger: new Ledger(config.dataDir) };
}
