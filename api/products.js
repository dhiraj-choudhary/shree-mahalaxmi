const fs = require('fs').promises;
const path = require('path');
const XLSX = require('xlsx');

module.exports = async (req, res) => {
  try {
    const jsonFile = path.join(process.cwd(), 'server', 'data', 'products.json');
    const xlsxFile = path.join(process.cwd(), 'server', 'data', 'products.xlsx');

    // prefer xlsx
    try {
      await fs.access(xlsxFile);
      const workbook = XLSX.readFile(xlsxFile, { cellDates: true });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) return res.status(200).json([]);
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { defval: null });
      return res.status(200).json(data);
    } catch (xlsxErr) {
      // fallback to JSON, and migrate
      try {
        const raw = await fs.readFile(jsonFile, 'utf8');
        const data = JSON.parse(raw);
        // migrate to xlsx for future
        try {
          const wb = XLSX.utils.book_new();
          const ws = XLSX.utils.json_to_sheet(data);
          XLSX.utils.book_append_sheet(wb, ws, 'Products');
          XLSX.writeFile(wb, xlsxFile);
          console.log('Migrated products.json -> products.xlsx');
        } catch (mErr) {
          console.error('Migration failed', mErr);
        }
        return res.status(200).json(data);
      } catch (jsonErr) {
        return res.status(200).json([]);
      }
    }
  } catch (err) {
    console.error('api/products error', err);
    return res.status(500).json({ error: 'Failed to load products' });
  }
};
