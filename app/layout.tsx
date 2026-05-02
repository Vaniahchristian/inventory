import type { Metadata } from "next"
import { Geist } from "next/font/google"
import "./globals.css"
import { Sidebar, MobileSidebar } from "@/components/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { ImportStoreProvider } from "@/lib/import-store"
import { ImportProgressToast } from "@/components/import-progress-toast"

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" })

export const metadata: Metadata = {
  title: "KizitoInventory",
  description: "Warehouse inventory management system",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <body className="h-full flex bg-slate-50 font-sans antialiased">
        <ImportStoreProvider>
          <Sidebar />
          <div className="flex flex-col flex-1 min-w-0">
            <header className="md:hidden flex items-center gap-3 px-4 py-3 bg-slate-900 border-b border-slate-700">
              <MobileSidebar />
              <span className="font-bold text-white text-sm">KizitoInventory</span>
            </header>
            <main className="flex-1 overflow-auto">
              {children}
            </main>
          </div>
          <ImportProgressToast />
          <Toaster richColors position="top-right" />
        </ImportStoreProvider>
      </body>
    </html>
  )
}
