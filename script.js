/* ============================================================
   INVOICE RESCUE — script.js
   ============================================================ */

(function () {
  'use strict';

  /* --- FAQ Accordion --- */
  var faqItems = document.querySelectorAll('.faq-item');

  faqItems.forEach(function (item) {
    var question = item.querySelector('.faq-item__question');
    var answer   = item.querySelector('.faq-item__answer');

    question.addEventListener('click', function () {
      var isOpen = item.classList.contains('is-open');

      // Close all
      faqItems.forEach(function (el) {
        el.classList.remove('is-open');
        el.querySelector('.faq-item__question').setAttribute('aria-expanded', 'false');
        el.querySelector('.faq-item__answer').style.maxHeight = '0';
      });

      // Open clicked if it was closed
      if (!isOpen) {
        item.classList.add('is-open');
        question.setAttribute('aria-expanded', 'true');
        answer.style.maxHeight = answer.scrollHeight + 'px';
      }
    });
  });


  /* --- Sticky Nav --- */
  var nav = document.querySelector('.nav');

  function onScroll() {
    if (window.scrollY > 80) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });


  /* --- Hamburger Menu --- */
  var hamburger   = document.querySelector('.nav__hamburger');
  var mobileMenu  = document.querySelector('.nav__mobile-menu');

  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', function () {
      var isOpen = hamburger.classList.toggle('is-open');
      mobileMenu.classList.toggle('is-open', isOpen);
      hamburger.setAttribute('aria-expanded', String(isOpen));
    });

    // Close mobile menu when a link is clicked
    mobileMenu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        hamburger.classList.remove('is-open');
        mobileMenu.classList.remove('is-open');
        hamburger.setAttribute('aria-expanded', 'false');
      });
    });
  }


  /* --- IntersectionObserver fade-in animations --- */
  var animEls = document.querySelectorAll('.anim-fade');

  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(
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


  /* --- Contact Form (Web3Forms) --- */
  var contactForm = document.getElementById('case-review-form');
  var formSuccess = document.getElementById('form-success');

  if (contactForm && formSuccess) {
    contactForm.addEventListener('submit', function (e) {
      e.preventDefault();

      var submitBtn = document.getElementById('form-submit-btn');
      var originalText = submitBtn.textContent;
      submitBtn.textContent = 'Submitting…';
      submitBtn.disabled = true;

      var formData = new FormData(contactForm);

      fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        body: formData
      })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        if (data.success) {
          contactForm.style.display = 'none';
          formSuccess.classList.add('is-visible');
          // Scroll to success message
          formSuccess.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          submitBtn.textContent = originalText;
          submitBtn.disabled = false;
          alert('Something went wrong. Please try emailing us at hello@invoicerescue.co.uk');
        }
      })
      .catch(function () {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
        alert('Something went wrong. Please try emailing us at hello@invoicerescue.co.uk');
      });
    });
  }

}());
