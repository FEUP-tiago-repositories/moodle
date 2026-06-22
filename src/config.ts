import dotenv from 'dotenv';

dotenv.config();

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  loginUrl: must('LOGIN_URL'),
  assignmentUrl: must('ASSIGNMENT_URL'),
  expectedFilename: must('EXPECTED_FILENAME'),
  profileDir: process.env.PROFILE_DIR || './profile',
  downloadsDir: process.env.DOWNLOADS_DIR || './downloads',
  stateFile: process.env.STATE_FILE || './state.json',
  upUsername: must('UP_USERNAME'),
  upPassword: must('UP_PASSWORD'),
  resendApiKey: must('RESEND_API_KEY'),
  emailFrom: must('EMAIL_FROM'),
  emailTo: must('EMAIL_TO'),
  emailSubject: must('EMAIL_SUBJECT'),
};
