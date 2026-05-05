'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Package,
  ArrowLeftRight,
  Truck,
  Menu,
  X,
  Boxes,
  FileSpreadsheet,
  MonitorPlay,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/products', label: 'Products', icon: Package },
  { href: '/stock', label: 'Stock Movements', icon: ArrowLeftRight },
  { href: '/suppliers', label: 'Suppliers', icon: Truck },
  { href: '/compiled-products', label: 'Compiled Products', icon: FileSpreadsheet },
  { href: '/live-view', label: 'Live View', icon: MonitorPlay },
]

function NavLink({ href, label, icon: Icon, onClick }: {
  href: string
  label: string
  icon: React.ElementType
  onClick?: () => void
}) {
  const pathname = usePathname()
  const active = pathname === href

  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-slate-800 text-white'
          : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-100'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </Link>
  )
}

export function Sidebar() {
  return (
    <aside className="hidden md:flex flex-col w-56 shrink-0 bg-slate-900 text-white min-h-screen">
      <SidebarContent />
    </aside>
  )
}

export function MobileSidebar() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="md:hidden p-2 text-slate-700"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-56 bg-slate-900 text-white flex flex-col">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="font-semibold text-white text-sm">Menu</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-white h-7 w-7"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <SidebarContent onNav={() => setOpen(false)} />
          </aside>
        </div>
      )}
    </>
  )
}

function SidebarContent({ onNav }: { onNav?: () => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-slate-300" />
          <span className="font-bold text-white tracking-tight">KizitoInventory</span>
        </div>
      </div>
      <Separator className="bg-slate-700" />
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {navItems.map(item => (
          <NavLink key={item.href} {...item} onClick={onNav} />
        ))}
      </nav>
      <Separator className="bg-slate-700" />
      <div className="px-4 py-3 text-xs text-slate-500">
        v1.0 · {new Date().getFullYear()}
      </div>
    </div>
  )
}
