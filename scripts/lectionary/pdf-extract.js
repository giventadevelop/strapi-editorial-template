'use strict';

/**
 * Extract text from PDFs for inspection. Used by import-liturgy-days-from-pdf.js --dump-text.
 * Returns { text, numPages } per PDF.
 *
 * For Malayalam/Indic scripts: uses a custom pagerender with disableCombineTextItems so
 * Unicode is preserved, and normalizes output to NFC so text matches the PDF display.
 */
const fs = require('fs');
const path = require('path');

/** Malayalam (and other Indic) text can be corrupted when text items are combined. */
function renderPagePreserveUnicode(pageData) {
  const renderOptions = {
    normalizeWhitespace: false,
    disableCombineTextItems: true, // preserve correct Unicode per item
  };
  return pageData
    .getTextContent(renderOptions)
    .then((textContent) => {
      let lastY;
      let text = '';
      for (const item of textContent.items) {
        if (lastY !== item.transform[5] && lastY != null) text += '\n';
        text += item.str || '';
        lastY = item.transform[5];
      }
      return text;
    })
    .catch(() => {
      return pageData.getTextContent({ normalizeWhitespace: false }).then((textContent) => {
        let lastY;
        let text = '';
        for (const item of textContent.items) {
          if (lastY !== item.transform[5] && lastY != null) text += '\n';
          text += item.str || '';
          lastY = item.transform[5];
        }
        return text;
      });
    });
}

async function extractPdfText(pdfPath) {
  const absolutePath = path.isAbsolute(pdfPath) ? pdfPath : path.resolve(process.cwd(), pdfPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error('PDF not found: ' + absolutePath);
  }
  const buffer = fs.readFileSync(absolutePath);
  const pdfParse = require('pdf-parse');
  const options = { pagerender: renderPagePreserveUnicode };
  const data = await pdfParse(buffer, options);
  let text = (data.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Unicode normalization (NFC) so Malayalam and other scripts match PDF display
  if (typeof text.normalize === 'function') text = text.normalize('NFC');
  return { text, numPages: data.numpages || 0 };
}

module.exports = { extractPdfText };
