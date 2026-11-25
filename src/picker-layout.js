'use strict';

const MIN_WIDTH = 420;

function computeLayout(constants, workArea) {
  const { padL, padR, cardW, gap, cardCount, cap, scrollbar = 0 } = constants;
  const capCols = Number.isFinite(cap)
    ? Math.floor((cap - scrollbar + gap) / (cardW + gap))
    : Infinity;
  const colsFit = Math.max(1, Math.floor((workArea.width - padL - padR - scrollbar + gap) / (cardW + gap)));
  const cols = Math.max(1, Math.min(cardCount, capCols, colsFit));
  const neededWidth = Math.ceil(padL + cols * cardW + (cols - 1) * gap + padR + scrollbar);
  const width = Math.min(Math.max(neededWidth, MIN_WIDTH), workArea.width);
  return { cols, rows: Math.ceil(cardCount / cols), width };
}

module.exports = { computeLayout, MIN_WIDTH };
