'use client';

// From easyui.site (NotificationStack). Changed for Gasho: the list is controlled by the caller
// (notifications / onDismiss / onSelect), the demo "Simulate" button is removed, and labels are Japanese.

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, AlertCircle, Info, X, Bell } from 'lucide-react';
import { cn } from '../../lib/utils';
import { motionTransitions } from '../../lib/motion-tokens';

export interface NotificationItem {
  id: string;
  title: string;
  description: string;
  type?: 'success' | 'info' | 'warning';
  time?: string;
}

export interface NotificationStackProps {
  notifications: NotificationItem[];
  onDismiss?: (id: string) => void;
  onSelect?: (id: string) => void;
  title?: string;
  emptyText?: string;
  className?: string;
  maxVisible?: number;
}

export const NotificationStack: React.FC<NotificationStackProps> = ({
  notifications,
  onDismiss,
  onSelect,
  title = '通知',
  emptyText = '新しい通知はありません',
  className,
  maxVisible = 3,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const getIcon = (type?: 'success' | 'info' | 'warning') => {
    switch (type) {
      case 'success':
        return <CheckCircle2 className="w-4 h-4 text-white" />;
      case 'warning':
        return <AlertCircle className="w-4 h-4 text-amber-400" />;
      default:
        return <Info className="w-4 h-4 text-[#ECECEC]" />;
    }
  };

  const visible = notifications.slice(0, isExpanded ? notifications.length : maxVisible);

  return (
    <div className={cn('flex flex-col gap-3 w-full select-none', className)}>
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2 text-xs font-medium text-[#A1A1A1]">
          <Bell className="w-3.5 h-3.5 text-[#525252]" />
          <span>
            {title}（{notifications.length}）
          </span>
        </div>
        {notifications.length > 1 && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-[11px] text-[#6B6B6B] hover:text-[#A1A1A1] transition-colors cursor-pointer"
          >
            {isExpanded ? '重ねる' : 'すべて表示'}
          </button>
        )}
      </div>

      <div
        className="relative"
        style={{ minHeight: notifications.length === 0 ? undefined : isExpanded ? undefined : 70 + Math.min(notifications.length, maxVisible) * 12 }}
      >
        <AnimatePresence mode="popLayout">
          {notifications.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="p-6 text-center rounded-xl border border-[#1F1F1F] bg-[#0E0E0E] text-xs text-[#6B6B6B]"
            >
              {emptyText}
            </motion.div>
          ) : (
            visible.map((item, index) => {
              const offset = index * 12;
              const scale = 1 - index * 0.04;
              const zIndex = notifications.length - index;

              return (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: -20, scale: 0.95 }}
                  animate={{
                    opacity: 1,
                    y: isExpanded ? 0 : offset,
                    scale: isExpanded ? 1 : scale,
                    zIndex,
                  }}
                  exit={{ opacity: 0, x: 80, scale: 0.9 }}
                  transition={motionTransitions.springResponsive}
                  drag="x"
                  dragConstraints={{ left: 0, right: 100 }}
                  onDragEnd={(_, info) => {
                    if (info.offset.x > 60) onDismiss?.(item.id);
                  }}
                  style={{
                    position: isExpanded ? 'relative' : 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    marginBottom: isExpanded ? 8 : 0,
                  }}
                  className="rounded-xl border border-[#1F1F1F] bg-[#0E0E0E] p-3.5 shadow-md cursor-grab active:cursor-grabbing hover:border-[#4A4A4A] transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div
                      className="flex items-start gap-2.5 min-w-0"
                      onClick={() => onSelect?.(item.id)}
                      role={onSelect ? 'button' : undefined}
                    >
                      <div className="mt-0.5 shrink-0">{getIcon(item.type)}</div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-xs font-semibold text-[#FAFAFA] truncate">{item.title}</h4>
                          <span className="text-[10px] text-[#6B6B6B] shrink-0">{item.time}</span>
                        </div>
                        {item.description && (
                          <p className="text-[11px] text-[#A1A1A1] mt-0.5 leading-snug line-clamp-2 break-all">
                            {item.description}
                          </p>
                        )}
                      </div>
                    </div>
                    {onDismiss && (
                      <button
                        onClick={() => onDismiss(item.id)}
                        className="text-[#525252] hover:text-[#FAFAFA] p-0.5 rounded transition-colors cursor-pointer shrink-0"
                        aria-label="既読にする"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </motion.div>
              );
            })
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
