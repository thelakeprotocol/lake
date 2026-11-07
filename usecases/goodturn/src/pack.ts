import type { LakePack } from '@thelakeprotocol/core';
import { TASKS } from './tasks.js';

const G = 'https://lake.doneinfifty.com/usecases/goodturn/v1#';

/**
 * Good turns: a demo charity's agent certifies small volunteer tasks done for it, one hour each, as Open Badges 3.0
 * credentials (SPEC §6.7). People may then price their own time in them: "go help Open Hands, and I'm yours for an hour".
 * It holds no one's records: houses don't load it; only the charity runs (as the pack's authority).
 */
export const goodturn: LakePack = {
  id: 'goodturn',
  version: '1.0.0',
  title: 'Good turns',
  vocab: G,
  folder: 'goodturn/',
  recordClass: `${G}DeedRecord`,
  fields: {},
  authority: {
    name: 'Open Hands (demo charity)',
    description: 'A demo charity. It certifies small volunteer tasks done for it as Open Badges 3.0 credentials, one hour of community service each, and redeems each one once when someone pays with it. { kind: "deed.tasks" } lists the tasks; { kind: "deed.submit", task, answer } earns a deed; { kind: "deed.redeem", credentials, cart, seller_card } pays a cart priced in HUR with them.',
    domain: 'charity.lake.local',
    path: 'charity',
    register: [],
    deeds: { tasks: TASKS },
  },
};
