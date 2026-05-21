# TrackOwl Backend API

Node.js/Express backend for the TrackOwl fleet tracking platform.

## Setup

### Prerequisites
- Node.js (v14+)
- MongoDB (local or cloud)
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

3. Update `.env` with your configuration:
```
MONGODB_URI=mongodb://localhost:27017/trackowl
JWT_SECRET=your_secure_jwt_secret_key
PORT=5000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
```

### Running the Server

Development mode (with auto-reload):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

Server will run on `http://localhost:5000`

## API Endpoints

### Authentication

#### Register New User
**POST** `/api/auth/register`

Request body:
```json
{
  "name": "Rajesh Patel",
  "email": "rajesh@example.com",
  "mobile": "9876543210",
  "password": "SecurePass123",
  "company": "Patel Roadlines",
  "fleet": "6–20 trucks"
}
```

Response (201):
```json
{
  "success": true,
  "message": "Account created successfully",
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

#### Login User
**POST** `/api/auth/login`

Request body:
```json
{
  "email": "rajesh@example.com",
  "password": "SecurePass123"
}
```

Response (200):
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

#### Get Current User
**GET** `/api/auth/me`

Headers:
```
Authorization: Bearer <token>
```

Response (200):
```json
{
  "success": true,
  "user": { ... }
}
```

#### Verify Token
**POST** `/api/auth/verify`

Headers:
```
Authorization: Bearer <token>
```

Response (200):
```json
{
  "success": true,
  "message": "Token is valid",
  "user": { ... }
}
```

### User Profile

#### Get Profile
**GET** `/api/user/profile`

Headers:
```
Authorization: Bearer <token>
```

Response (200):
```json
{
  "success": true,
  "user": { ... }
}
```

#### Update Profile
**PUT** `/api/user/profile`

Headers:
```
Authorization: Bearer <token>
```

Request body (all fields optional):
```json
{
  "name": "Updated Name",
  "mobile": "9999999999",
  "company": "New Company Name",
  "fleet": "50+ trucks"
}
```

Response (200):
```json
{
  "success": true,
  "message": "Profile updated successfully",
  "user": { ... }
}
```

#### Change Password
**POST** `/api/user/change-password`

Headers:
```
Authorization: Bearer <token>
```

Request body:
```json
{
  "currentPassword": "OldPassword123",
  "newPassword": "NewPassword456",
  "confirmPassword": "NewPassword456"
}
```

Response (200):
```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

### Health Check
**GET** `/api/health`

Response (200):
```json
{
  "status": "ok",
  "message": "TrackOwl Backend is running"
}
```

## Error Handling

All errors follow this format:
```json
{
  "success": false,
  "error": "Error message"
}
```

Common HTTP Status Codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request (validation error)
- `401` - Unauthorized (invalid credentials or token)
- `403` - Forbidden (inactive account)
- `404` - Not Found
- `409` - Conflict (email already exists)
- `500` - Internal Server Error

## Database Schema

### User Model
```
{
  _id: ObjectId,
  name: String (required, min: 2),
  email: String (required, unique, valid format),
  mobile: String (required, 10 digits),
  password: String (required, min: 8, hashed),
  company: String (required),
  fleet: String (enum: 1–5, 6–20, 21–50, 50+ trucks),
  role: String (enum: admin, client, default: client),
  isActive: Boolean (default: true),
  createdAt: Date (default: now)
}
```

## Integration with Frontend

### Storing Token
After login/register, store the token in localStorage:
```javascript
localStorage.setItem('token', response.data.token);
```

### Using Token in Requests
Add token to all authenticated requests:
```javascript
const token = localStorage.getItem('token');
const response = await fetch('/api/auth/me', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

### Example React Integration
```javascript
const loginUser = async (email, password) => {
  const response = await fetch('http://localhost:5000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await response.json();
  if (data.success) {
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    window.location.href = '/dashboard';
  }
};
```

## Security Considerations

- Passwords are hashed using bcryptjs (10 salt rounds)
- JWTs expire in 7 days
- CORS is enabled only for specified origin
- All user inputs are validated
- MongoDB connection uses authentication (add to `.env`)
- Never commit `.env` file with real credentials

## Development

### Project Structure
```
backend/
├── models/          # Database schemas
├── routes/          # API endpoints
├── middleware/      # Express middleware
├── utils/          # Helper functions
├── server.js       # Entry point
├── package.json    # Dependencies
├── .env.example    # Environment template
└── README.md       # This file
```

## Next Steps

- Add fleet management endpoints
- Add vehicle tracking APIs
- Implement invoice generation
- Add real-time GPS tracking
- Setup payment integration
