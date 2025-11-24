
#include "user_timer.h"


void Timer_Init(void)
{
	HAL_TIM_Base_Start_IT(&htim1);
}

void setTimer(TIMEVAL value)
{
	TIM1->ARR = TIM1->CNT + value;
}


TIMEVAL getElapsedTime(void)
{
	return TIM1->CNT;
}



void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
	TimeDispatch();
}


