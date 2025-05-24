const nodemailer = require('nodemailer');
const notificationQueue = require('../queues/notificationQueue');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

notificationQueue.process(async (job) => {
  const { userEmail, authorName, postTitle, postId } = job.data;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: userEmail,
    subject: `Check This New Post By ${authorName}!`,
    html: `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Post Notification</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f7f7f7; color: #333; }
          .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1); }
          .header { background-color: #c6caf9; padding: 20px; text-align: center; color: #fff; }
          .header h1 { margin: 0; font-size: 24px; }
          .content { padding: 20px; }
          .cta { text-align: center; margin: 20px 0; }
          .cta a { display: inline-block; padding: 12px 20px; font-size: 16px; color: #fff; background-color: #c6caf9; text-decoration: none; border-radius: 25px; }
          .footer { text-align: center; font-size: 12px; color: #999; background-color: #f7f7f7; padding: 10px 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>New Post Alert</h1>
          </div>
          <div class="content">
            <p>Hi,</p>
            <p><strong>${authorName}</strong> just published a new post titled <strong>${postTitle}</strong>!</p>
            <div class="cta">
              <a href="https://berony.web.app/reading/${postId}">Read the Post</a>
            </div>
          </div>
          <div class="footer">
            <p>If you no longer wish to receive these emails, <a href="mailto:${process.env.EMAIL_USER}">contact us</a>.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${userEmail} for post ${postId}`);
  } catch (error) {
    console.error(`Failed to send email to ${userEmail}:`, error);
    throw error;
  }
});