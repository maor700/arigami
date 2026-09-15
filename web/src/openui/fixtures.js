// OPENUI pilot — sample blocks shared by the demo page and test/openui-web.test.js.
export const FIXTURES = [
  {
    name: 'kpis + bar chart',
    title: 'Sign-ups this week',
    ui: 'root = Stack([kpis, chart])\nkpis = Stack([s1, s2, s3], "row")\ns1 = Stat("Visitors", "12,480", "+8%")\ns2 = Stat("Sign-ups", "312", "-2%")\ns3 = Stat("המרה", "2.5%")\nchart = BarChart(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], [120, 180, 150, 210, 240, 90, 60], "Sign-ups per day")',
  },
  {
    name: 'line chart + table (hebrew)',
    ui: 'root = Stack([c])\nc = Card("מכירות לפי חודש", [line, tbl, note])\nline = LineChart(["ינו","פבר","מרץ","אפר","מאי","יוני"], [4200, 3900, 5100, 4800, 6100, 7300])\ntbl = Table(["חודש", "מכירות", "יעד"], [["ינו", 4200, 4000], ["פבר", 3900, 4000], ["מרץ", 5100, 4500]])\nnote = Markdown("**מסקנה:** מרץ עבר את היעד ב-13%. [פרטים](https://example.com)")',
  },
  {
    name: 'form',
    ui: 'root = Stack([card])\ncard = Card("מה להזמין?", [form])\nform = Form("order", [item, qty, rush], "שלח", "Order form submitted")\nitem = Select("item", "פריט", ["חלב", "לחם", "ביצים"])\nqty = TextInput("qty", "כמות", "1", "2")\nrush = Checkbox("rush", "משלוח מהיר", true)',
  },
  {
    name: 'buttons',
    ui: 'root = Stack([t, row])\nt = Text("Deploy v0.2.1 to production?", "strong")\nrow = Stack([yes, no], "row")\nyes = Button("Deploy", "Yes, deploy v0.2.1 to production", "primary")\nno = Button("Not now", "No, hold the deploy")',
  },
  { name: 'unknown component (fallback)', ui: 'root = Stack([x])\nx = PieChart([1,2,3])' },
  { name: 'garbage (fallback)', ui: 'this is not openui ((( ' },
];
