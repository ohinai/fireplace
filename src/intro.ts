// The main page: where to sit (a picture of each place), what the fire does and how it works. It
// is what a first visit opens on; after that the place chosen last lights straight away, and the
// house button brings the main page back, over the fire, which burns on behind it.
//
// Back and Forward treat it as a page of its own (a history entry marked { intro: true }): Back
// from a fire lit from it comes back to it, and Back from it, opened over a fire, returns to the
// fire. They only ever show it or hide it: the fire burning is the one chosen last.

import type { RoomKey } from './rooms';

export interface Intro {
  /** Whether it is showing. */
  readonly open: boolean;
  /** A place was chosen on it (other than where the fire is burning): light a fire there. */
  onPick: (key: RoomKey) => void;
  /** The next place chosen. */
  next(): Promise<RoomKey>;
  /** Where the fire is burning now (it offers to go back to it). */
  setBurning(key: RoomKey): void;
  /** No fire can be lit in this browser: shows the main page, saying why, with no place to choose. */
  unavailable(html: string): void;
  /** Takes it down at once (something went wrong, and a message says what). */
  close(): void;
}

/** The main page's history entry. (A fire's has no state.) */
const STATE = { intro: true };

/** Whether a history entry is the main page's. */
const isIntro = (state: unknown) => (state as { intro?: unknown } | null)?.intro === true;

/**
 * Sets up the main page, showing it first if there is no fire to go straight to (or if it was
 * showing when the page was reloaded). index.html has already shown it or not, as the page loaded.
 */
export function createIntro(showFirst: boolean): Intro {
  const root = document.documentElement;
  const el = document.getElementById('intro')!;
  const app = document.getElementById('app')!;
  const title = document.getElementById('intro-title')!;
  const back = document.getElementById('intro-back') as HTMLButtonElement;
  const after = document.getElementById('intro-after')!;
  const notice = document.getElementById('intro-notice')!;
  const home = document.getElementById('home') as HTMLButtonElement;
  const cards = [...el.querySelectorAll<HTMLAnchorElement>('a[data-room]')];
  const badge = document.createElement('span');
  badge.className = 'burning';
  badge.textContent = 'Still burning';

  let open = false;
  let burning: RoomKey | null = null;
  let fromFire = false; // opened with the house button: the fire's history entry is the one before
  let off = false; // no fire can be lit here
  let fade: Animation | null = null;
  let leaving = 0; // (the timer that takes it down once it has faded out)
  const waiting: ((key: RoomKey) => void)[] = [];
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const show = () => {
    clearTimeout(leaving);
    fade?.cancel();
    fade = null;
    if (open) return;
    open = true;
    root.classList.add('intro');
    app.inert = true;
    if (!burning) return;
    // Over the fire: its controls go, and the page fades in from the top, with focus on its title.
    el.scrollTop = 0;
    title.focus({ preventScroll: true });
    if (!still()) fade = el.animate({ opacity: [0, 1] }, { duration: 250, easing: 'ease-out' });
  };

  const hide = () => {
    if (!open) return;
    open = false;
    fade?.cancel();
    const done = () => {
      const focused = el.contains(document.activeElement);
      root.classList.remove('intro');
      app.inert = false;
      fade?.cancel();
      fade = null;
      // (Focus was on the page, now gone: to the button that brings it back.)
      if (focused) home.focus({ preventScroll: true });
    };
    if (still()) {
      done();
      return;
    }
    fade = el.animate({ opacity: [1, 0] }, { duration: 300, easing: 'ease-in', fill: 'forwards' });
    // (On a timer: an animation's end waits for the page to be drawn, and a hidden tab's isn't.)
    leaving = window.setTimeout(done, 300);
  };

  /** Back to the fire burning behind it. */
  const toFire = () => {
    if (!open || !burning) return;
    if (fromFire) {
      // (Its entry is the one before: going back to it hides the page, below.)
      history.back();
    } else {
      history.pushState(null, '', location.href);
      hide();
    }
    fromFire = false;
  };

  const choose = (key: RoomKey) => {
    if (!open || off) return;
    if (key === burning) {
      toFire();
      return;
    }
    history.pushState(null, '', location.href);
    fromFire = false;
    api.onPick(key);
    for (const resolve of waiting.splice(0)) resolve(key);
    hide();
  };

  for (const a of cards) {
    a.addEventListener('click', (e) => {
      // (One meant for a new tab or window is left to the link: the fire lights there.)
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      choose(a.dataset.room as RoomKey);
    });
  }
  back.addEventListener('click', toFire);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) toFire();
  });

  // The house button, over the fire: the main page, as a page of its own (at the site's own
  // address, not one naming a room, so that it is the main page that gets shared).
  home.addEventListener('click', () => {
    if (open) return;
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.pushState(STATE, '', url);
    show();
    fromFire = true;
  });

  window.addEventListener('popstate', (e) => {
    fromFire = false;
    if (isIntro(e.state)) show();
    else if (burning) hide();
  });

  if (showFirst || isIntro(history.state)) {
    // (So that a reload, or Back from the fire, finds it again.)
    history.replaceState(STATE, '');
    show();
  } else {
    root.classList.remove('intro');
  }

  const api: Intro = {
    get open() {
      return open;
    },
    onPick: () => {},
    next: () => new Promise((resolve) => waiting.push(resolve)),
    setBurning: (key) => {
      burning = key;
      for (const a of cards) {
        if (a.dataset.room === key) {
          a.append(badge);
          a.setAttribute('aria-current', 'true');
        } else {
          a.removeAttribute('aria-current');
        }
      }
      after.textContent = 'Your fire is still burning: choose it to go back to it, or another place for a new fire.';
      back.hidden = false;
    },
    unavailable: (html) => {
      off = true;
      // (Shown first, then filled, so that screen readers read it out.)
      notice.hidden = false;
      notice.innerHTML = html;
      for (const a of cards) a.removeAttribute('href');
      after.hidden = true;
      if (!open) {
        history.replaceState(STATE, '');
        show();
      }
    },
    close: () => {
      clearTimeout(leaving);
      fade?.cancel();
      fade = null;
      open = false;
      root.classList.remove('intro');
      app.inert = false;
    },
  };
  return api;
}
