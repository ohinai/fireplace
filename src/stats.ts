// Counting visits and a few events with GoatCounter (the script in index.html): no cookies, and
// nothing that identifies anyone. Each event shows in the GoatCounter dashboard as a path of its
// own. (Nothing is counted from localhost, and ad blockers often stop it altogether.)

interface GoatCounter {
  count(vars: { path: string; title?: string; event?: boolean }): void;
}

const waiting: [string, string][] = [];
let retrying = false;

const goatcounter = () => (window as unknown as { goatcounter?: Partial<GoatCounter> }).goatcounter;

/** Counts an event (a path such as 'room/campfire'), as soon as GoatCounter has loaded. */
export function countEvent(path: string, title = path) {
  const gc = goatcounter();
  if (gc?.count) {
    gc.count({ path, title, event: true });
    return;
  }
  // (Its script loads in the background: hold on to the event until it has, or give up after a while.)
  waiting.push([path, title]);
  if (retrying) return;
  retrying = true;
  let tries = 0;
  const retry = () => {
    const g = goatcounter();
    if (g?.count) {
      for (const [p, t] of waiting.splice(0)) g.count({ path: p, title: t, event: true });
    } else if (++tries < 30) {
      setTimeout(retry, 1000);
      return;
    } else {
      waiting.length = 0;
    }
    retrying = false;
  };
  setTimeout(retry, 1000);
}
