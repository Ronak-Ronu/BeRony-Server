require('dotenv').config();
const nodemailer = require('nodemailer');
const User = require('../models/User');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});


transporter.verify((error, success) => {
  if (error) {
    console.error('Nodemailer configuration error:', error);
    process.exit(1);
  } else {
    console.log('Nodemailer ready to send emails');
  }
  if (success) {
    console.log('Nodemailer configuration verified successfully');
  }
});
exports.sendEmailNotification = async (followerId, authorName, postTitle, postId) => {
  // const { followerId, authorName, postTitle, postId } = job.data;
  // console.log(`Processing job ${job.id} for follower ${followerId}`);

  try{
    const follower = await User.findOne({ userId: followerId })
    if (!follower) {
      console.warn(`Follower with ID ${followerId} not found`);
      return; // Skip job instead of throwing
    }

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: follower.userEmail,
      subject: `New Post by ${authorName}`,
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

    const info = await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${follower.userEmail}: ${info.response}`);


  }
  catch (error) {
    console.error('Error sending email notification:', error);
    throw error; 
  }

}