# API Testing Guide

Use these cURL commands to test the TrackOwl Backend API.

## Quick Setup

1. Start MongoDB:
```bash
mongod
```

2. Start backend server:
```bash
npm run dev
```

3. Copy commands below and run in a terminal/PowerShell

## Test Commands

### 1. Health Check
```bash
curl http://localhost:5000/api/health
```

Expected response:
```json
{"status":"ok","message":"TrackOwl Backend is running"}
```

---

### 2. Register New User

```bash
curl -X POST http://localhost:5000/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{
    "name": "Rajesh Patel",
    "email": "rajesh@example.com",
    "mobile": "9876543210",
    "password": "TrackOwl@2026",
    "company": "Patel Roadlines",
    "fleet": "6–20 trucks"
  }'
```

**Save the token** from response - you'll need it for authenticated requests.

---

### 3. Register Another User

```bash
curl -X POST http://localhost:5000/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{
    "name": "Priya Singh",
    "email": "priya@example.com",
    "mobile": "9988776655",
    "password": "SecurePass123",
    "company": "Singh Transport Co.",
    "fleet": "21–50 trucks"
  }'
```

---

### 4. Login User

```bash
curl -X POST http://localhost:5000/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{
    "email": "rajesh@example.com",
    "password": "TrackOwl@2026"
  }'
```

Expected response includes a token:
```json
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "_id": "...",
    "name": "Rajesh Patel",
    "email": "rajesh@example.com",
    "mobile": "9876543210",
    "company": "Patel Roadlines",
    "fleet": "6–20 trucks",
    "role": "client"
  }
}
```

---

### 5. Get Current User (Authenticated)

Replace `YOUR_TOKEN` with the token from login response.

```bash
$token = "YOUR_TOKEN"
curl -X GET http://localhost:5000/api/auth/me `
  -H "Authorization: Bearer $token"
```

---

### 6. Verify Token

```bash
$token = "YOUR_TOKEN"
curl -X POST http://localhost:5000/api/auth/verify `
  -H "Authorization: Bearer $token"
```

---

### 7. Get User Profile

```bash
$token = "YOUR_TOKEN"
curl -X GET http://localhost:5000/api/user/profile `
  -H "Authorization: Bearer $token"
```

---

### 8. Update User Profile

```bash
$token = "YOUR_TOKEN"
curl -X PUT http://localhost:5000/api/user/profile `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $token" `
  -d '{
    "name": "Rajesh Patel Updated",
    "mobile": "9999999999",
    "company": "Patel Roadlines Pvt. Ltd.",
    "fleet": "50+ trucks"
  }'
```

---

### 9. Change Password

```bash
$token = "YOUR_TOKEN"
curl -X POST http://localhost:5000/api/user/change-password `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $token" `
  -d '{
    "currentPassword": "TrackOwl@2026",
    "newPassword": "NewPassword456",
    "confirmPassword": "NewPassword456"
  }'
```

---

## Error Test Cases

### Invalid Email Format
```bash
curl -X POST http://localhost:5000/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{
    "name": "Test User",
    "email": "invalid-email",
    "mobile": "9876543210",
    "password": "TestPass123",
    "company": "Test Co",
    "fleet": "1–5 trucks"
  }'
```

Expected: `400` error - "Invalid email format"

---

### Password Too Short
```bash
curl -X POST http://localhost:5000/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "mobile": "9876543210",
    "password": "short",
    "company": "Test Co",
    "fleet": "1–5 trucks"
  }'
```

Expected: `400` error - "Password must be at least 8 characters"

---

### Invalid Mobile Number
```bash
curl -X POST http://localhost:5000/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "mobile": "123",
    "password": "TestPass123",
    "company": "Test Co",
    "fleet": "1–5 trucks"
  }'
```

Expected: `400` error - "Mobile must be a valid 10-digit number"

---

### Duplicate Email Registration
```bash
# First registration
curl -X POST http://localhost:5000/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{
    "name": "User One",
    "email": "duplicate@example.com",
    "mobile": "9876543210",
    "password": "TestPass123",
    "company": "Test Co",
    "fleet": "1–5 trucks"
  }'

# Second registration with same email
curl -X POST http://localhost:5000/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{
    "name": "User Two",
    "email": "duplicate@example.com",
    "mobile": "9999999999",
    "password": "TestPass123",
    "company": "Another Co",
    "fleet": "6–20 trucks"
  }'
```

Expected: `409` error - "Email already registered"

---

### Wrong Password Login
```bash
curl -X POST http://localhost:5000/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{
    "email": "rajesh@example.com",
    "password": "WrongPassword"
  }'
```

Expected: `401` error - "Invalid credentials"

---

### Missing Required Fields
```bash
curl -X POST http://localhost:5000/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{
    "name": "Test User"
  }'
```

Expected: `400` error - "All fields are required"

---

### Invalid Token
```bash
curl -X GET http://localhost:5000/api/auth/me `
  -H "Authorization: Bearer invalid_token_here"
```

Expected: `401` error - "Invalid or expired token"

---

### No Token Provided
```bash
curl -X GET http://localhost:5000/api/auth/me
```

Expected: `401` error - "No token provided"

---

## Using Postman

1. Import collection or create requests manually
2. Set request type and URL
3. Add headers:
   - `Content-Type: application/json`
   - `Authorization: Bearer YOUR_TOKEN` (for authenticated endpoints)
4. Add request body as JSON
5. Click Send

---

## MongoDB Check

Verify data in MongoDB:

```bash
mongosh
use trackowl
db.users.find()
db.users.findOne({ email: "rajesh@example.com" })
```

---

## Notes

- Tokens expire in 7 days
- Passwords are hashed before storing
- Email is case-insensitive (stored in lowercase)
- All timestamps are in UTC
- Fleet size must be one of: "1–5 trucks", "6–20 trucks", "21–50 trucks", "50+ trucks"
