//+------------------------------------------------------------------+
//|                                  AKRAM_MeanReversion_EA.mq5       |
//|              AKRAM Trading Bot - Mean Reversion (RSI+BB+EMA+ATR)  |
//|                     Da usare SOLO nel terminale MetaTrader 5      |
//+------------------------------------------------------------------+
#property copyright "AKRAM Trading Bot"
#property version   "2.00"
#property description "Mean reversion: RSI + Bollinger Bands + EMA trend filter + ATR risk management"

#include <Trade\Trade.mqh>

input group "=== RSI ==="
input int    InpRsiPeriod       = 14;
input double InpRsiOverbought   = 70.0;
input double InpRsiOversold     = 30.0;

input group "=== Bollinger Bands ==="
input int    InpBbPeriod        = 20;
input double InpBbDeviation     = 2.0;

input group "=== EMA (filtro di trend) ==="
input int    InpEmaFast         = 20;
input int    InpEmaMedium       = 50;
input int    InpEmaSlow         = 200;

input group "=== ATR / Risk Management ==="
input int    InpAtrPeriod       = 14;
input double InpAtrStopMult     = 1.5;
input double InpAtrTargetMult   = 3.0;
input double InpRiskPercent     = 1.0;
input int    InpMaxPositions    = 2;
input int    InpMaxTradesPerDay = 3;
input double InpMaxDrawdownPct  = 20.0;

input group "=== Generali ==="
input ulong  InpMagicNumber     = 20260814;
input ulong  InpSlippagePoints  = 30;

CTrade trade;

int hRsi, hBb, hEmaFast, hEmaMedium, hEmaSlow, hAtr;
datetime lastBarTime    = 0;
double   equityPeak     = 0;
int      tradesToday    = 0;
datetime tradesTodayDay = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   hRsi       = iRSI(_Symbol, PERIOD_CURRENT, InpRsiPeriod, PRICE_CLOSE);
   hBb        = iBands(_Symbol, PERIOD_CURRENT, InpBbPeriod, 0, InpBbDeviation, PRICE_CLOSE);
   hEmaFast   = iMA(_Symbol, PERIOD_CURRENT, InpEmaFast, 0, MODE_EMA, PRICE_CLOSE);
   hEmaMedium = iMA(_Symbol, PERIOD_CURRENT, InpEmaMedium, 0, MODE_EMA, PRICE_CLOSE);
   hEmaSlow   = iMA(_Symbol, PERIOD_CURRENT, InpEmaSlow, 0, MODE_EMA, PRICE_CLOSE);
   hAtr       = iATR(_Symbol, PERIOD_CURRENT, InpAtrPeriod);

   if(hRsi == INVALID_HANDLE || hBb == INVALID_HANDLE || hEmaFast == INVALID_HANDLE ||
      hEmaMedium == INVALID_HANDLE || hEmaSlow == INVALID_HANDLE || hAtr == INVALID_HANDLE)
     {
      Print("AKRAM EA: errore nella creazione degli indicatori");
      return(INIT_FAILED);
     }

   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpSlippagePoints);

   equityPeak = AccountInfoDouble(ACCOUNT_EQUITY);

   PrintFormat("AKRAM Mean Reversion EA v2.0 avviata su %s %s", _Symbol, EnumToString(PERIOD_CURRENT));
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(hRsi);
   IndicatorRelease(hBb);
   IndicatorRelease(hEmaFast);
   IndicatorRelease(hEmaMedium);
   IndicatorRelease(hEmaSlow);
   IndicatorRelease(hAtr);
}

//+------------------------------------------------------------------+
bool IsNewBar()
{
   datetime t[];
   if(CopyTime(_Symbol, PERIOD_CURRENT, 0, 1, t) < 1)
      return false;
   if(t[0] != lastBarTime)
     {
      lastBarTime = t[0];
      return true;
     }
   return false;
}

//+------------------------------------------------------------------+
void ResetDailyCounterIfNeeded()
{
   datetime day = (datetime)(TimeCurrent() - TimeCurrent() % 86400);
   if(day != tradesTodayDay)
     {
      tradesTodayDay = day;
      tradesToday = 0;
     }
}

//+------------------------------------------------------------------+
double CurrentDrawdownPercent()
{
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(equity > equityPeak)
      equityPeak = equity;
   if(equityPeak <= 0)
      return 0;
   return (equityPeak - equity) / equityPeak * 100.0;
}

//+------------------------------------------------------------------+
int CountOwnPositions()
{
   int count = 0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == (long)InpMagicNumber &&
            PositionGetString(POSITION_SYMBOL) == _Symbol)
            count++;
        }
     }
   return count;
}

//+------------------------------------------------------------------+
double CalcLotSize(double stopDistancePoints)
{
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double riskAmount = equity * (InpRiskPercent / 100.0);

   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickSize <= 0)
      tickSize = _Point;

   double valuePerPoint = tickValue * (_Point / tickSize);
   double stopValue = stopDistancePoints * valuePerPoint;
   if(stopValue <= 0)
      return 0;

   double lots = riskAmount / stopValue;

   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(lotStep <= 0)
      lotStep = minLot > 0 ? minLot : 0.01;

   lots = MathFloor(lots / lotStep) * lotStep;
   lots = MathMax(minLot, MathMin(maxLot, lots));

   return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
void ManageOpenPositions(double close)
{
   double rsiVal[], emaFastVal[];
   ArraySetAsSeries(rsiVal, true);
   ArraySetAsSeries(emaFastVal, true);
   if(CopyBuffer(hRsi, 0, 0, 2, rsiVal) < 2)
      return;
   if(CopyBuffer(hEmaFast, 0, 0, 2, emaFastVal) < 2)
      return;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(!PositionSelectByTicket(ticket))
         continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)InpMagicNumber)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;

      long type = PositionGetInteger(POSITION_TYPE);
      bool exitSignal = false;

      if(type == POSITION_TYPE_BUY && (rsiVal[1] > InpRsiOverbought || close >= emaFastVal[1]))
         exitSignal = true;
      else if(type == POSITION_TYPE_SELL && (rsiVal[1] < InpRsiOversold || close <= emaFastVal[1]))
         exitSignal = true;

      if(exitSignal)
         trade.PositionClose(ticket);
     }
}

//+------------------------------------------------------------------+
void OnTick()
{
   if(!IsNewBar())
      return;
   ResetDailyCounterIfNeeded();

   double rsi[], bbUpper[], bbLower[], emaSlow[], atr[];
   ArraySetAsSeries(rsi, true);
   ArraySetAsSeries(bbUpper, true);
   ArraySetAsSeries(bbLower, true);
   ArraySetAsSeries(emaSlow, true);
   ArraySetAsSeries(atr, true);

   if(CopyBuffer(hRsi, 0, 0, 3, rsi) < 3)
      return;
   if(CopyBuffer(hBb, 1, 0, 3, bbUpper) < 3)
      return;
   if(CopyBuffer(hBb, 2, 0, 3, bbLower) < 3)
      return;
   if(CopyBuffer(hEmaSlow, 0, 0, 3, emaSlow) < 3)
      return;
   if(CopyBuffer(hAtr, 0, 0, 3, atr) < 3)
      return;

   double close = iClose(_Symbol, PERIOD_CURRENT, 1);

   long volAvg = 0;
   for(int i = 1; i <= 20; i++)
      volAvg += iVolume(_Symbol, PERIOD_CURRENT, i);
   volAvg /= 20;
   long vol = iVolume(_Symbol, PERIOD_CURRENT, 1);

   ManageOpenPositions(close);

   if(CurrentDrawdownPercent() > InpMaxDrawdownPct)
      return;
   if(tradesToday >= InpMaxTradesPerDay)
      return;
   if(CountOwnPositions() >= InpMaxPositions)
      return;

   bool longSignal  = (rsi[1] < InpRsiOversold) && (close <= bbLower[1]) && (close > emaSlow[1]) && (vol > volAvg * 1.2);
   bool shortSignal = (rsi[1] > InpRsiOverbought) && (close >= bbUpper[1]) && (close < emaSlow[1]) && (vol > volAvg * 1.2);

   double atrPoints = atr[1] / _Point;
   MqlTick tick;
   SymbolInfoTick(_Symbol, tick);

   if(longSignal)
     {
      double sl = close - atr[1] * InpAtrStopMult;
      double tp = close + atr[1] * InpAtrTargetMult;
      double lots = CalcLotSize(atrPoints * InpAtrStopMult);
      if(lots > 0 && trade.Buy(lots, _Symbol, tick.ask, sl, tp, "AKRAM_LONG"))
         tradesToday++;
     }
   else if(shortSignal)
     {
      double sl = close + atr[1] * InpAtrStopMult;
      double tp = close - atr[1] * InpAtrTargetMult;
      double lots = CalcLotSize(atrPoints * InpAtrStopMult);
      if(lots > 0 && trade.Sell(lots, _Symbol, tick.bid, sl, tp, "AKRAM_SHORT"))
         tradesToday++;
     }
}
//+------------------------------------------------------------------+
