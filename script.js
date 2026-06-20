/* ============================================================
   INVOICE RESCUE — script.js
   ============================================================ */

(function () {
  'use strict';

  /* --- FAQ Accordion --- */
  const faqItems = document.querySelectorAll('.faq-item');

  faqItems.forEach(function (item) {
    const question = item.querySelector('.faq-item__question');
    const answer   = item.querySelector('.faq-item__answer');

    question.addEventListener('click', function () {
      const isOpen = item.classList.contains('is-open');

      // Close all
      faqItems.forEach(function (el) {
        el.classList.remove('is-open');
        el.querySelector('.faq-item__answer').style.maxHeight = '0';
      });

      // Open clicked if it was closed
      if (!isOpen) {
        item.classList.add('is-open');
        answer.style.maxHeight = answer.scrollHeight + 'px';
      }
    });
  });


  /* --- Sticky Nav --- */
  const nav = document.querySelector('.nav');

  function onScroll() {
    if (window.scrollY > 80) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });


  /* --- Hamburger Menu --- */
  const hamburger   = document.querySelector('.nav__hamburger');
  const mobileMenu  = document.querySelector('.nav__mobile-menu');

  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', function () {
      const isOpen = hamburger.classList.toggle('is-open');
      mobileMenu.classList.toggle('is-open', isOpen);
      hamburger.setAttribute('aria-expanded', String(isOpen));
    });
  }


  /* --- CTA mailto links --- */
  const MAILTO = 'mailto:hello@invoicerescue.co.uk?subject=Invoice%20Rescue%20%E2%80%94%20Free%20Case%20Review%20Request';

  document.querySelectorAll('[data-cta]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      window.location.href = MAILTO;
    });
  });


  /* --- Smooth Scroll for anchor links --- */
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });


  /* --- IntersectionObserver fade-in animations --- */
  const animEls = document.querySelectorAll('.anim-fade');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );

    animEls.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // Fallback: just show everything
    animEls.forEach(function (el) { el.classList.add('is-visible'); });
  }

}());
