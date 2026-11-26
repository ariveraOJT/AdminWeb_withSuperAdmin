const STUDENT_HEADERS = {
  student_no: ['student no', 'student number', 'lrn'],
  currently_section: [
    'grade level & section',
    'grade level and section',
    'currently section',
    'current section',
    'section',
  ],
  full_name: ['student full name', 'full name', 'name'],
};

const STUDENT_FIELD_LABELS = {
  student_no: 'Student No.',
  currently_section: 'Grade Level & Section',
  full_name: 'Student Full Name',
};

const normalizeHeader = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[._-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/[.:]/g, '')
  .trim();

const getCellText = (value) => {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
};

const readStudentSheet = (sheet) => {
  if (!sheet || !sheet.data?.length) {
    throw new Error('The workbook must contain a non-empty Students sheet.');
  }

  const headers = sheet.data[0].map(normalizeHeader);
  const columns = Object.fromEntries(
    Object.entries(STUDENT_HEADERS).map(([field, aliases]) => [
      field,
      headers.findIndex((header) => aliases.includes(header)),
    ])
  );
  const missingHeaders = Object.entries(columns)
    .filter(([, index]) => index < 0)
    .map(([field]) => STUDENT_FIELD_LABELS[field]);
  if (missingHeaders.length) {
    throw new Error(`Students sheet is missing required columns: ${missingHeaders.join(', ')}.`);
  }

  const students = [];
  const rejected = [];
  const seenStudentNumbers = new Set();
  for (let index = 1; index < sheet.data.length; index += 1) {
    const row = sheet.data[index];
    const student = {
      student_no: getCellText(row[columns.student_no]).replace(/\s+/g, ''),
      currently_section: getCellText(row[columns.currently_section]),
      full_name: getCellText(row[columns.full_name]),
      row_number: index + 1,
    };
    if (!student.student_no && !student.currently_section && !student.full_name) continue;

    const issues = [];
    if (!/^\d{11,12}$/.test(student.student_no)) {
      issues.push('Student No. must contain 11 or 12 digits. Keep it as text in Excel.');
    }
    if (!student.currently_section) issues.push('Grade Level & Section is required.');
    if (!student.full_name) issues.push('Student Full Name is required.');
    if (student.full_name.length > 200) issues.push('Student Full Name must be 200 characters or fewer.');
    if (student.currently_section.length > 100) {
      issues.push('Grade Level & Section must be 100 characters or fewer.');
    }
    if (seenStudentNumbers.has(student.student_no)) {
      issues.push('Duplicate Student No. in this workbook.');
    }
    seenStudentNumbers.add(student.student_no);

    if (issues.length) {
      rejected.push({
        sheet: 'Students',
        rowNumber: student.row_number,
        identifier: student.student_no || 'Blank Student No.',
        reason: issues.join(' '),
      });
    } else {
      students.push(student);
    }
  }

  if (students.length + rejected.length === 0) {
    throw new Error('The Students sheet must contain at least one student row after the header.');
  }
  if (students.length + rejected.length > 5000) {
    throw new Error('The workbook must contain no more than 5000 non-empty student rows.');
  }

  return { students, rejected, totalRows: students.length + rejected.length };
};

export function parseRosterSheets(sheets) {
  const studentSheet = sheets.find((sheet) => normalizeHeader(sheet.sheet) === 'students')
    || sheets.find((sheet) => sheet.data?.length);
  return readStudentSheet(studentSheet);
}

export async function parseRosterWorkbook(file) {
  if (!file || !/\.xlsx$/i.test(file.name)) {
    throw new Error('Please select an Excel workbook in .xlsx format.');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('The workbook must be 10 MB or smaller.');
  }

  const { default: readXlsxFile } = await import('read-excel-file/browser');
  return parseRosterSheets(await readXlsxFile(file));
}
