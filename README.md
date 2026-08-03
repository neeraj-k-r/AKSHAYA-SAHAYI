# 🏛️ AKSHAYA SAHAYI

> A Digital E-Governance Platform that streamlines citizen service requests, document verification, payment processing, and application tracking through Akshaya Centers.

---

## 📖 Overview

AKSHAYA SAHAYI is a full-stack e-governance platform designed to simplify the process of applying for government services online. The platform connects **Citizens**, **Akshaya Center Officials**, and **System Administrators** through a secure role-based system, providing transparent application tracking similar to Flipkart's order tracking.

The platform minimizes paperwork, improves communication between citizens and Akshaya centers, enables secure online payments, and provides real-time status updates throughout the application lifecycle.

---

# 🎯 Objectives

- Digitize government service applications.
- Reduce manual paperwork.
- Improve transparency in application processing.
- Allow citizens to track applications in real time.
- Enable secure online payments.
- Simplify document verification.
- Provide centralized service management for administrators.

---

# 👥 User Roles

## 👤 Citizen

Citizens can:

- Register/Login
- Browse available government services
- View required documents
- Upload required documents
- Submit applications
- Track application progress
- Receive correction requests
- Pay service fees online
- Download completed certificates
- View application history
- Receive notifications

---

## 🏢 Akshaya Center Official

Officials can:

- Login using admin-created accounts
- View assigned applications
- Review uploaded documents
- Approve or reject documents
- Request document corrections
- Verify payments
- Process applications
- Upload completed certificates
- Update application status
- View transaction history

---

## 👨‍💼 System Administrator

Administrators can:

- Manage Akshaya Centers
- Create official accounts
- Manage government services
- Define required documents
- Configure service fees
- Enable/Disable online services
- Monitor all applications
- View reports & analytics
- Manage users
- Platform administration

---

# 🚀 Features

## Citizen Portal

- Service Catalog
- Online Application Submission
- Document Upload
- Real-time Status Tracking
- Payment Gateway
- Certificate Download
- Notifications
- Profile Management

---

## Akshaya Dashboard

- Application Review
- Document Verification
- Correction Requests
- Payment Verification
- Certificate Upload
- Status Management
- Revenue Dashboard

---

## Admin Dashboard

- Service Management
- Akshaya Center Management
- User Management
- Reports
- Analytics
- Platform Settings

---

# 📌 Government Service Workflow

```text
Citizen

↓

Select Government Service

↓

View Required Documents

↓

Upload Documents

↓

Submit Application

↓

Akshaya Center Review

↓

Approved?
        │
        ├── No
        │
        ├── Correction Requested
        │
        └── Citizen Reuploads
        │
        ▼
      Review Again

↓

Payment Request

↓

Online Payment

↓

Payment Verified

↓

Processing

↓

Certificate Generated

↓

Citizen Downloads Certificate
```

---

# 📍 Application Status Flow

Applications pass through multiple stages.

```text
Submitted

↓

Under Review

↓

Correction Required

↓

Documents Verified

↓

Payment Pending

↓

Payment Completed

↓

Processing

↓

Completed

↓

Certificate Downloaded
```

Each status includes

- Timestamp
- Officer Remarks
- Progress Indicator

---

# 💳 Payment Flow

- Citizen submits application.
- Official verifies documents.
- Payment request generated.
- Citizen pays securely through Razorpay.
- Payment status updated.
- Official processes application.
- Certificate delivered.

---

# 📂 Core Modules

## Citizen Module

- Dashboard
- Government Services
- Apply for Service
- My Applications
- Application Tracking
- Payments
- Notifications
- Profile

---

## Official Module

- Dashboard
- Pending Applications
- Review Documents
- Correction Requests
- Payment Verification
- Completed Applications
- Profile

---

## Administrator Module

- Dashboard
- Manage Government Services
- Manage Required Documents
- Manage Akshaya Centers
- Manage Officials
- View Reports
- User Management
- Platform Settings

---

# 🏗️ System Architecture

```text
                 React Frontend
                       │
        ┌──────────────┼──────────────┐
        │              │              │
Citizen Dashboard  Official Dashboard  Admin Dashboard
        │              │              │
        └──────────────┼──────────────┘
                       │
                 Express Backend
                       │
      ┌──────────┬────────────┬──────────┐
      │          │            │          │
 Supabase   Cloudinary   Razorpay   WhatsApp Bot
      │          │            │          │
 Database   File Storage   Payments   Messaging
```

---

# 🛠️ Technology Stack

## Frontend

- React.js
- Vite
- Tailwind CSS
- React Router
- Axios
- React Icons
- Framer Motion

---

## Backend

- Node.js
- Express.js

---

## Database

- Supabase PostgreSQL

---

## Storage

- Cloudinary

---

## Payment Gateway

- Razorpay

---

## Messaging

- Kapso WhatsApp API

---

# 📁 Proposed Folder Structure

```
src/

├── assets/
├── components/
│   ├── layout/
│   ├── cards/
│   ├── tables/
│   ├── forms/
│   ├── timeline/
│   ├── ui/
│   └── common/
│
├── pages/
│   ├── admin/
│   ├── official/
│   ├── citizen/
│   ├── auth/
│   └── public/
│
├── layouts/
├── routes/
├── hooks/
├── services/
├── context/
├── utils/
├── data/
└── App.jsx
```

---

# 🗃️ Database Tables

- Users
- Akshaya Centers
- Government Services
- Required Documents
- Applications
- Uploaded Documents
- Payments
- Notifications
- Status History

---

# 📊 Dashboard Features

## Admin Dashboard

- Total Applications
- Total Citizens
- Total Officials
- Total Revenue
- Service Statistics
- Monthly Reports
- Activity Timeline

---

## Official Dashboard

- Pending Reviews
- Processing Applications
- Completed Applications
- Today's Revenue
- Payment History

---

## Citizen Dashboard

- Application Summary
- Recent Applications
- Status Timeline
- Notifications
- Payment History

---

# 📦 Project Status

### Phase 1 (Current)

- UI/UX Design
- React Dashboard
- Reusable Components
- Responsive Layout
- Mock Data Integration

---

### Phase 2

- Supabase Integration
- REST APIs
- Authentication
- Role-Based Access
- CRUD Operations

---

### Phase 3

- Cloudinary Integration
- Razorpay Payment Integration
- Application Tracking
- Notifications

---

### Phase 4

- WhatsApp Bot Integration
- AI Assistant
- Report Generation
- Deployment

---

# 🔒 Security (Planned)

- JWT Authentication
- Role-Based Access Control (RBAC)
- Secure File Uploads
- HTTPS
- Password Hashing
- Protected Routes
- Secure Payment Verification

---

# 🌟 Future Enhancements

- Mobile Application
- AI Chatbot Assistance
- WhatsApp-Based Application Tracking
- SMS Notifications
- Email Notifications
- OCR-Based Document Verification
- Multi-language Support
- QR Code Certificate Verification
- Digital Signature Support
- Government API Integrations

---

# 🎓 Academic Project

**Project Title**

**AKSHAYA SAHAYI – A Digital E-Governance Platform for Citizen Service Management**

This project is developed as a full-stack academic project demonstrating modern web development practices, secure role-based access, cloud storage integration, online payment processing, and real-time government service tracking.

---

## 👨‍💻 Developed Using

- React.js
- Tailwind CSS
- Node.js
- Express.js
- Supabase
- Cloudinary
- Razorpay
- Kapso WhatsApp API

---

## 📜 License

This project is developed for educational and academic purposes.
