const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {getProvider} = require('./storage');

const JWT_SECRET = process.env.JWT_SECRET || 'monkey-tracker-insecure-secret';
const TOKEN_TTL = process.env.JWT_TTL || '8h';

function sanitizeUser(user){
  if(!user){
    return null;
  }
  const {id, email, name, role, createdAt, updatedAt} = user;
  return {id, email, name, role, createdAt, updatedAt};
}

async function hashPassword(password){
  const rounds = Number(process.env.PASSWORD_ROUNDS) || 10;
  return bcrypt.hash(password, rounds);
}

async function validateUserCredentials(email, password){
  if(!email || !password){
    return null;
  }
  const provider = getProvider();
  const user = await provider.getUserByEmail(email);
  if(!user){
    return null;
  }
  const isValid = await bcrypt.compare(password, user.passwordHash);
  if(!isValid){
    return null;
  }
  return user;
}

function issueToken(user){
  return jwt.sign({
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name
  }, JWT_SECRET, {expiresIn: TOKEN_TTL});
}

function parseTokenFromRequest(req){
  const header = req.headers.authorization || '';
  if(typeof header === 'string'){
    const [scheme, token] = header.split(' ');
    if(scheme && token && scheme.toLowerCase() === 'bearer'){
      return token.trim();
    }
  }
  if(req.query && typeof req.query.access_token === 'string'){
    return req.query.access_token.trim();
  }
  return null;
}

async function authenticate(req, res, next){
  const token = parseTokenFromRequest(req);
  if(!token){
    res.status(401).json({error: 'Authentication required'});
    return;
  }
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    const provider = getProvider();
    const user = await provider.getUserById(payload.sub);
    if(!user){
      res.status(401).json({error: 'Invalid token'});
      return;
    }
    req.user = sanitizeUser(user);
    next();
  }catch(err){
    console.warn('Token verification failed', err.message);
    res.status(401).json({error: 'Invalid token'});
  }
}

function requireRole(roles){
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next)=>{
    if(!req.user){
      res.status(401).json({error: 'Authentication required'});
      return;
    }
    if(!allowed.includes(req.user.role)){
      res.status(403).json({error: 'Insufficient permissions'});
      return;
    }
    next();
  };
}

async function loginHandler(req, res){
  const {email, password} = req.body || {};
  const user = await validateUserCredentials(email, password);
  if(!user){
    res.status(401).json({error: 'Invalid email or password'});
    return;
  }
  const token = issueToken(user);
  res.json({token, user: sanitizeUser(user)});
}

async function registerUserHandler(req, res){
  const {email, name, password, role = 'viewer'} = req.body || {};
  if(!email || !password || !name){
    res.status(400).json({error: 'Email, name and password are required'});
    return;
  }
  const provider = getProvider();
  const existing = await provider.getUserByEmail(email);
  if(existing){
    res.status(409).json({error: 'User already exists'});
    return;
  }
  const passwordHash = await hashPassword(password);
  const user = await provider.createUser({email, name, role, passwordHash});
  res.status(201).json({user: sanitizeUser(user)});
}

async function meHandler(req, res){
  res.json({user: req.user});
}

module.exports = {
  authenticate,
  requireRole,
  loginHandler,
  registerUserHandler,
  meHandler,
  hashPassword,
  sanitizeUser
};
