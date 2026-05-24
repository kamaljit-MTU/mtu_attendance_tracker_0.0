Short description:

# mtu_attendance_tracker_0.0
MTU Attendance Tracker - A comprehensive attendance management system with geofencing, selfie verification, manual time entry, and Excel reporting. Built for educational institutions with separate instructor and student portals.

Detailed description:

# 📚 MTU Attendance Tracker

A production-ready attendance management system designed for educational institutions, featuring real-time geofencing, selfie verification, and comprehensive reporting. Built with Node.js, Express, and vanilla JavaScript – no database setup required!

## ✨ Features

### 👨‍🏫 For Instructors
- **Class Management** - Create classes with multiple time slots per day (different timings for different days)
- **Geofencing** - Set location boundaries with custom radius (10-500m) - students must be within range to mark attendance
- **Manual Attendance** - Mark attendance manually for any date, even non-class days
- **Student Enrollment** - Enroll students manually or via CSV/Excel bulk upload
- **Attendance Calendar** - View monthly attendance matrix with P/L/A status and overall percentage
- **Excel Export** - Download color-coded attendance reports (P/L/A format)
- **Profile Settings** - Update name, email, and password
- **Live Location Tracking** - Shows student's distance from geofenced area during check-in
- **Initial login credentials: Username- instructor@mtu.ac.in Password- admin123 (Can change this later on from Instructor>Profile Settings)

### 👩‍🎓 For Students
- **Selfie Attendance** - Mark attendance with camera capture (required for students)
- **Self-Enrollment** - Enroll in classes using course code
- **Attendance History** - View personal attendance calendar with percentage
- **Geofence Validation** - Automatic location check before marking attendance
- **Time Validation** - Can only mark attendance during scheduled class hours
- **Profile Settings** - Update personal information

### 📊 Core Features
- **Multiple Time Slots** - Different timings for different days (e.g., Mon 9-11am, Wed 2-4pm)
- **IST Timezone** - All dates and times displayed in Indian Standard Time
- **Overall Attendance %** - Calculated from first present/late record to last
- **Dark Theme UI** - Modern, eye-friendly interface
- **Responsive Design** - Works on desktop, tablet, and mobile browsers
- **No Database Setup** - Uses simple JSON file storage (portable, no installation)

## 🚀 Quick Start

### Prerequisites
  1. Node.js (v14 or higher). 
      Please download an appropriate version from https://nodejs.org/en/download. Setup should be pretty straight forward for this!
  2. npm 
      This comes with Node.js installed above. It is used in managing the js file.
  3. ngrok 
      It is required to tunnel local ports to public URL. This helps in sharing the link with students. 
      Please go to https://ngrok.com/ and create your account. Download ngrok from the appropriate store according to your OS system (e.g., Microsoft Store for Windows systems).
      Run the "ngrok config add-authtoken ..." in your terminal (Linux/MacOS)/command prompt (Windows systems)
      Run then ngrok http 3000 (port used here is 3000)


### Installation
## The following commands are run at terminal/command prompt

```bash
# Clone the repository
git clone https://github.com/yourusername/mtu-attendance-tracker.git
cd mtu-attendance-tracker

# Install dependencies
npm install express bcryptjs jsonwebtoken multer exceljs csv-parser

# Start the server
node server.js

# Start ngrok
ngrok http 3000
Copy the link shown in your terminal/command prompt (https...) "Forwarding                    https://something-random-given-here.ngrok-free.dev -> http://localhost:3000"
Shorten it (bitly etc.) or share it as is to your students.


Default Login
Instructor: instructor@mtu.ac.in / admin123

Students: Create your own account via registration

Open http://localhost:3000 and start tracking attendance!

🛠️ Technology Stack
Backend: Node.js, Express.js

Authentication: JWT (JSON Web Tokens), bcryptjs

File Upload: Multer

Excel Generation: ExcelJS

CSV Parsing: csv-parser

Database: JSON file (No MongoDB/PostgreSQL needed!)

Frontend: Vanilla HTML/CSS/JavaScript (No frameworks)

📁 Project Structure
text
mtu-attendance-tracker/
├── server.js              # Main application file
├── database.json          # Auto-generated database (users, classes, attendance)
├── uploads/               # Selfie images and temp files
│   ├── selfies/          # Captured selfie images
│   └── temp/             # Temporary upload folder
├── package.json          # Dependencies
└── README.md             # This file
📸 Screenshots
Instructor Dashboard
Create classes with flexible scheduling

Manage geofencing with visual radius slider

View real-time attendance statistics

Attendance Calendar
Color-coded matrix (P = Present, L = Late, A = Absent)

Overall percentage calculated over entire course period

Export to Excel with one click

Student Attendance
Camera capture for selfie verification

GPS location validation

Time-based restrictions (only during class hours)

🔒 Security Features
Password hashing with bcrypt

JWT-based authentication

Role-based access control (instructor/student)

Selfie verification prevents proxy attendance

Geofencing prevents remote attendance marking

📊 API Endpoints
Method	Endpoint	Description
POST	/api/register	Create student account
POST	/api/login	User login
POST	/api/classes	Create new class (instructor)
PUT	/api/classes/:id	Update class details
POST	/api/attendance	Mark attendance with selfie
POST	/api/manual-attendance	Manual attendance entry
GET	/api/calendar/:id/:year/:month	Get monthly calendar
GET	/api/export/:id/:year/:month	Export Excel report
PUT	/api/profile	Update user profile
🎯 Use Cases
Universities & Colleges - Track lecture attendance

Training Centers - Monitor student participation

Corporate Training - Employee attendance tracking

Workshops & Seminars - Session-wise attendance

🤝 Contributing
Contributions are welcome! Please feel free to submit a Pull Request.

📄 License
MIT License - feel free to use for personal or commercial projects.

🙏 Acknowledgments
Inspired by modern attendance systems like Jibble

Built for Manipur Technical University (MTU)

Special thanks to all contributors

📧 Contact
For support or queries, please open an issue on GitHub.

Star ⭐ this repository if you find it useful!
