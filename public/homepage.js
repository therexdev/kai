/* Progressive enhancement: the six screenshots remain scrollable without JS. */
(() => {
  const rail = document.getElementById('mobile-shots');
  if (!rail) return;
  const slides = [...rail.querySelectorAll('.mobile-slide')];
  const previous = document.getElementById('mobile-prev');
  const next = document.getElementById('mobile-next');
  const position = document.getElementById('mobile-position');
  const controls = document.querySelector('.carousel-controls');
  controls.hidden = false;
  let queued = false;
  function update() {
    const atEnd = rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2;
    const index = slides.reduce((best, slide, i) =>
      Math.abs(slide.offsetLeft - slides[0].offsetLeft - rail.scrollLeft) <
      Math.abs(slides[best].offsetLeft - slides[0].offsetLeft - rail.scrollLeft) ? i : best, 0);
    previous.disabled = rail.scrollLeft <= 2;
    next.disabled = atEnd;
    // At the end, the final screenshot is visible even on a multi-card layout.
    position.textContent = `${atEnd ? slides.length : index + 1} / ${slides.length}`;
  }
  function move(direction) {
    const distance = slides[1].offsetLeft - slides[0].offsetLeft;
    rail.scrollBy({left: direction * distance, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  }
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  rail.addEventListener('keydown', event => {
    if (event.target !== rail) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1);
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); rail.scrollTo({left: event.key === 'Home' ? 0 : rail.scrollWidth, behavior: 'instant'});
    }
  });
  rail.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }, {passive: true});
  new ResizeObserver(update).observe(rail);
  update();
})();
