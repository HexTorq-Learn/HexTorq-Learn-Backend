import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = express.Router();

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/).optional().or(z.literal('')),
  phone: z.string().min(7).max(20).regex(/^[0-9+\-\s()]+$/).optional().or(z.literal('')),
  password: z.string().min(6),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function signUser(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
}

function normalizeUserInput(body) {
  return {
    name: body.name.trim(),
    email: body.email.trim().toLowerCase(),
    username: body.username?.trim() ? body.username.trim().toLowerCase() : null,
    phone: body.phone?.trim() ? body.phone.trim().replace(/\s+/g, '') : null,
    password: body.password,
  };
}

async function findDuplicateUser({ email, username, phone }, excludeId) {
  const checks = [];
  if (email) checks.push({ email });
  if (username) checks.push({ username });
  if (phone) checks.push({ phone });
  if (!checks.length) return null;

  const user = await prisma.user.findFirst({
    where: {
      OR: checks,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { email: true, username: true, phone: true },
  });

  if (!user) return null;
  if (user.email === email) return 'Email already exists';
  if (username && user.username === username) return 'Username already exists';
  if (phone && user.phone === phone) return 'Phone already exists';
  return 'User already exists';
}

authRouter.get('/availability', async (req, res, next) => {
  try {
    const query = z.object({
      email: z.string().email().optional(),
      username: z.string().min(3).max(40).optional(),
      phone: z.string().min(7).max(20).optional(),
    }).parse(req.query);
    const normalized = {
      email: query.email?.trim().toLowerCase(),
      username: query.username?.trim().toLowerCase(),
      phone: query.phone?.trim().replace(/\s+/g, ''),
    };
    const message = await findDuplicateUser(normalized);
    res.json({ available: !message, message });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const body = normalizeUserInput(registerSchema.parse(req.body));
    const duplicateMessage = await findDuplicateUser(body);
    if (duplicateMessage) {
      return res.status(409).json({ message: duplicateMessage });
    }

    const existingUsers = await prisma.user.count();
    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        username: body.username,
        phone: body.phone,
        passwordHash,
        role: existingUsers === 0 ? 'ADMIN' : 'STUDENT',
      },
      select: { id: true, name: true, email: true, username: true, phone: true, role: true },
    });

    res.status(201).json({ user, token: signUser(user) });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'Email already exists' });
    }
    next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: body.email.toLowerCase() },
    });

    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      phone: user.phone,
      role: user.role,
    };

    res.json({ user: safeUser, token: signUser(user) });
  } catch (error) {
    next(error);
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
