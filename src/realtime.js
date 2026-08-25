import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { prisma } from './prisma.js';
import { getAllowedOrigins } from './cors.js';

let io;

export function initRealtime(server) {
  io = new Server(server, {
    transports: ['websocket'],
    cors: {
      origin: getAllowedOrigins(),
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Missing token'));

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true },
      });

      if (!user) return next(new Error('Invalid token'));

      socket.user = user;
      socket.join(`user:${user.id}`);
      if (user.role === 'ADMIN') socket.join('admins');
      return next();
    } catch (error) {
      return next(error);
    }
  });

  return io;
}

export function emitUserMetrics(userId, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit('metrics:update', payload);
  io.to('admins').emit('admin:metrics:update', { userId, ...payload });
}

export function emitNotification(userId, notification) {
  if (!io) return;
  io.to(`user:${userId}`).emit('notification:new', notification);
}
