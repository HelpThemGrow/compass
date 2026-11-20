import type { Metadata } from "next";
import "./globals.css";
<<<<<<< HEAD
import { ThemeProvider } from "@/components/providers/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
=======
>>>>>>> 32f2f75

export const metadata: Metadata = {
  title: "Compass",
  description: "Guiding teams through frameworks, compliance, and document standards",
<<<<<<< HEAD
  icons: { icon: "/vibha-logo.png" },
=======
>>>>>>> 32f2f75
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
<<<<<<< HEAD
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <TooltipProvider delayDuration={250}>
            {children}
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </ThemeProvider>
      </body>
=======
    <html lang="en">
      <body>{children}</body>
>>>>>>> 32f2f75
    </html>
  );
}
