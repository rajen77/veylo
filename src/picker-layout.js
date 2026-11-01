'use strict';

const MIN_WIDTH = 420;

/**
 * Column count and window width for the service chooser, from the layout
 * constants the page reports and the display's work area. A row holds as many
 * cards as the grid's max-width allows (NaN when uncapped), as fit on the
 * display, and as there are services.
 */
function computeLayout(constants, workArea) {
  const { padL, padR, cardW, gap, cardCount, cap } = constants;
  const capCols = Number.isFinite(cap)
    ? Math.floor((cap + gap) / (cardW + gap))
    : Infinity;
  const colsFit = Math.max(1, Math.floor((workArea.width - padL - padR + gap) / (cardW + gap)));
  const cols = Math.max(1, Math.min(cardCount, capCols, colsFit));
  const neededWidth = Math.ceil(padL + cols * cardW + (cols - 1) * gap + padR);
  const width = Math.min(Math.max(neededWidth, MIN_WIDTH), workArea.width);
  return { cols, rows: Math.ceil(cardCount / cols), width };
}

module.exports = { computeLayout, MIN_WIDTH };
