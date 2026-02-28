'use strict';

/**
 * Extract text from PDFs for inspection. Used by import-liturgy-days-from-pdf.js --dump-text.
 * Returns { text, numPages } per PDF.
 */
const fs = require('fs');
const path = require('path');

async function extractPdfText(pdfPath) {
  const absolutePath = path.isAbsolute(pdfPath) ? pdfPath : path.resolve(process.cwd(), pdfPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error('PDF not found: ' + absolutePath);
  }
  const buffer = fs.readFileSync(absolutePath);
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return { text: data.text || '', numPages: data.numpages || 0 };
}

module.exports = { extractPdfText };
