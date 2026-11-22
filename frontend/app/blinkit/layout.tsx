import BlinkitNav from "@/components/blinkit/BlinkitNav";
import { PageHeader } from "@/components/ui";

export default function GroceriesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-8 pb-16">
      <div className="space-y-6">
        <PageHeader title="Groceries" description="From your Blinkit invoices." />
        <BlinkitNav />
      </div>
      {children}
    </div>
  );
}
